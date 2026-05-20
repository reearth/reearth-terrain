// Orchestrator for bulk mirror sweeps. One operator gesture mirrors
// every archive that matches a bbox / archive-allow-list, with md5
// diffing against the sweep's recorded state and bounded
// concurrency so the underlying R2 multipart bandwidth isn't
// saturated.
//
// "Sweep" because the operator wants the whole filtered set mirrored
// in one go — contrast with `MapterhornRotationWorkflow`, which
// drip-feeds one archive at a time on a daily schedule.
//
// Selection: filtered set minus archives whose upstream md5sum
// matches the last successful sweep's recorded state. md5 diff is in
// addition to the executor's own version-skip — the diff here avoids
// even spawning a child workflow for an unchanged archive, which
// matters when the filtered set runs into the hundreds.
//
// Concurrency: items are mirrored in batches of N (env-configurable).
// Each batch spawns its children, then polls all of them to terminal
// before moving on. `step.sleep(30 min)` between polls keeps the
// parent's step count bounded even when a child runs for days
// (planet.pmtiles).

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  bboxIntersects,
  fetchUpstreamManifest,
  type Bbox,
  type ManifestItem,
  type Terminal,
} from "./mapterhorn-orchestrator.js";

export interface MapterhornSweepParams {
  /** [minLon, minLat, maxLon, maxLat]. Regional archives whose bbox intersects this are kept. planet.pmtiles passes the filter unconditionally. */
  bbox?: Bbox;
  /** Explicit allow-list of archive filenames. Takes precedence over `bbox`. */
  archives?: string[];
  /** Skip `planet.pmtiles`. */
  skipPlanet?: boolean;
  /** Mirror even when md5sum matches the last recorded successful sweep. */
  force?: boolean;
  /** How many child workflows to run concurrently. Clamped to [1, 8]. */
  concurrency?: number;
  /** Safety brake — refuse if the resolved target count exceeds this. */
  maxItems?: number;
}

interface LastState {
  version?: string;
  /** Map of archive name -> md5sum of the most recent successful mirror. */
  mirrored: Record<string, string>;
  updatedAt: string;
}

const STATE_KEY_SUFFIX = "/manifest.last.json";
const POLL_INTERVAL = "30 minutes";

export class MapterhornSweepWorkflow extends WorkflowEntrypoint<Env, MapterhornSweepParams> {
  override async run(event: WorkflowEvent<MapterhornSweepParams>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload ?? {};

    const { manifest, last } = await step.do("fetch-manifest", async () => {
      const manifest = await fetchUpstreamManifest(this.env.MAPTERHORN_UPSTREAM_BASE);
      const stateKey = `${this.env.MAPTERHORN_MIRROR_PREFIX}${STATE_KEY_SUFFIX}`;
      const lastObj = await this.env.R2.get(stateKey);
      const last: LastState = lastObj
        ? ((await lastObj.json()) as LastState)
        : { mirrored: {}, updatedAt: new Date(0).toISOString() };
      return { manifest, last };
    });

    const targets = filterTargets(manifest.items, params, last);

    const concurrency = clamp(
      params.concurrency ?? Number.parseInt(this.env.MAPTERHORN_SWEEP_CONCURRENCY ?? "2", 10),
      1,
      8,
    );
    const maxItems = params.maxItems ?? Number.parseInt(this.env.MAPTERHORN_SWEEP_MAX_ITEMS ?? "200", 10);
    if (targets.length > maxItems) {
      throw new Error(
        `refusing to mirror ${targets.length} items, exceeds maxItems=${maxItems}. Pass {maxItems: N} to override.`,
      );
    }

    console.log(
      JSON.stringify({
        event: "sweep_planned",
        manifestVersion: manifest.version,
        total: targets.length,
        concurrency,
      }),
    );

    if (targets.length === 0) {
      return { ok: true, manifestVersion: manifest.version, total: 0, results: {} };
    }

    const results: Record<string, { status: Terminal; md5: string; error?: string }> = {};

    const batches = chunk(targets, concurrency);
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]!;

      // Spawn-then-poll, batch-shaped. Inlined rather than calling
      // `spawnAndPollMirror` per child because the sweep wants to
      // overlap the spawn calls and poll the whole batch together —
      // running children in lock-step minimizes the time the slowest
      // child holds up the next batch.
      const spawned = await step.do(`spawn:batch-${b}`, async () => {
        const out: Array<{ name: string; id: string; md5: string }> = [];
        for (const item of batch) {
          const inst = await this.env.MAPTERHORN_MIRROR.create({ params: { archive: item.name } });
          out.push({ name: item.name, id: inst.id, md5: item.md5sum });
        }
        return out;
      });

      let pending = spawned;
      for (let iter = 0; pending.length > 0; iter++) {
        await step.sleep(`sleep:batch-${b}:${iter}`, POLL_INTERVAL);
        const remaining = await step.do(`poll:batch-${b}:${iter}`, async () => {
          const out: typeof pending = [];
          for (const p of pending) {
            const inst = await this.env.MAPTERHORN_MIRROR.get(p.id);
            const s = await inst.status();
            const terminal = asTerminal(s.status);
            if (terminal) {
              const errorMsg =
                terminal === "complete" ? undefined : safeErrorMessage(s) ?? terminal;
              results[p.name] = { status: terminal, md5: p.md5, error: errorMsg };
            } else {
              out.push(p);
            }
          }
          return out;
        });
        pending = remaining;
      }
    }

    await step.do("write-manifest", async () => {
      const next: LastState = {
        version: manifest.version,
        // Carry forward previously-mirrored md5s. Successful runs in
        // this invocation overwrite; failed ones leave the previous
        // entry intact (next run will retry the same name).
        mirrored: { ...last.mirrored },
        updatedAt: new Date().toISOString(),
      };
      for (const [name, r] of Object.entries(results)) {
        if (r.status === "complete") next.mirrored[name] = r.md5;
      }
      await this.env.R2.put(
        `${this.env.MAPTERHORN_MIRROR_PREFIX}${STATE_KEY_SUFFIX}`,
        JSON.stringify(next, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      );
    });

    const successes = Object.values(results).filter((r) => r.status === "complete").length;
    console.log(
      JSON.stringify({
        event: "sweep_complete",
        manifestVersion: manifest.version,
        total: targets.length,
        succeeded: successes,
        failed: targets.length - successes,
      }),
    );
    return {
      ok: true,
      manifestVersion: manifest.version,
      total: targets.length,
      succeeded: successes,
      failed: targets.length - successes,
      results,
    };
  }
}

function filterTargets(
  items: ManifestItem[],
  p: MapterhornSweepParams,
  last: LastState,
): ManifestItem[] {
  let out = items;
  if (p.skipPlanet) out = out.filter((i) => i.name !== "planet.pmtiles");
  if (p.archives && p.archives.length > 0) {
    const allow = new Set(p.archives);
    out = out.filter((i) => allow.has(i.name));
  } else if (p.bbox) {
    out = out.filter((i) => i.name === "planet.pmtiles" || bboxIntersects(i, p.bbox!));
  }
  if (!p.force) {
    out = out.filter((i) => last.mirrored[i.name] !== i.md5sum);
  }
  return out;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function asTerminal(s: string): Terminal | null {
  return s === "complete" || s === "errored" || s === "terminated" ? s : null;
}

function safeErrorMessage(s: unknown): string | undefined {
  if (!s || typeof s !== "object") return undefined;
  const err = (s as { error?: unknown }).error;
  if (err == null) return undefined;
  return typeof err === "string" ? err : JSON.stringify(err);
}

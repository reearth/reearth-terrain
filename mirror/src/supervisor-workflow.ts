// Supervisor Workflow that fans out per-archive Mapterhorn mirror runs
// across the 458-item PMTiles set published at
// `download.mapterhorn.com/download_urls.json` (planet + ~457 z6
// regional archives, ~9.8 TiB total).
//
// Design choices:
//   - md5sum diff against the previous run's recorded state means a
//     monthly run only re-mirrors archives whose upstream actually
//     changed. Re-downloading 9.8 TiB monthly would be wasteful — and
//     would routinely exceed the per-archive Workflow lifetime.
//   - Bounded concurrency. Cloudflare Workflows have an account-wide
//     concurrent-instance budget and R2 multipart uploads aren't free,
//     so we cap to a small N and wait between batches rather than
//     fan all 458 out at once.
//   - Safety brake (`maxItems`) refuses to proceed if the diff is
//     suspiciously large — guards against a manifest format change or
//     upstream rebuild making us re-mirror everything by accident.
//   - Optional bbox / archive filters let callers run partial mirrors
//     (e.g. "Japan-only" tier) without touching the workflow code.
//
// Polling pattern: each batch spawns its child instances, then loops
// `step.sleep` + `step.do(poll)` until every child reaches a terminal
// state. Workflows persists `step.sleep` durably so the parent
// instance idles cheaply for the hours-to-days a large child takes.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface MapterhornSupervisorParams {
  /** [minLon, minLat, maxLon, maxLat]. Regional archives whose bbox intersects this are kept. planet.pmtiles passes the filter unconditionally. */
  bbox?: [number, number, number, number];
  /** Explicit allow-list of archive filenames. Takes precedence over `bbox`. */
  archives?: string[];
  /** Skip `planet.pmtiles`. */
  skipPlanet?: boolean;
  /** Mirror even when md5sum matches the last recorded successful mirror. */
  force?: boolean;
  /** How many child workflows to run concurrently. Clamped to [1, 8]. */
  concurrency?: number;
  /** Safety brake — refuse if the resolved target count exceeds this. */
  maxItems?: number;
}

interface ManifestItem {
  name: string;
  url: string;
  md5sum: string;
  size: number;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  min_zoom: number;
  max_zoom: number;
}

interface Manifest {
  version: string;
  items: ManifestItem[];
}

interface LastState {
  version?: string;
  /** Map of archive name -> md5sum of the most recent successful mirror. */
  mirrored: Record<string, string>;
  updatedAt: string;
}

type Terminal = "complete" | "errored" | "terminated";

const MANIFEST_PATH = "/download_urls.json";
const STATE_KEY_SUFFIX = "/manifest.last.json";
// 30 minutes balances responsiveness against the per-instance step
// budget: long-tail children (planet.pmtiles can run for days) would
// otherwise generate thousands of poll steps. `step.sleep` is durable
// and the parent doesn't count toward the concurrent-instance limit
// while waiting, so a longer interval is essentially free.
const POLL_INTERVAL = "30 minutes";

export class MapterhornSupervisorWorkflow extends WorkflowEntrypoint<Env, MapterhornSupervisorParams> {
  override async run(event: WorkflowEvent<MapterhornSupervisorParams>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload ?? {};

    const { manifest, last } = await step.do("fetch-manifest", async () => {
      const url = `${this.env.MAPTERHORN_UPSTREAM_BASE}${MANIFEST_PATH}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
      const manifest = (await r.json()) as Manifest;
      if (!Array.isArray(manifest.items)) throw new Error(`manifest.items is not an array`);

      const stateKey = `${this.env.MAPTERHORN_MIRROR_PREFIX}${STATE_KEY_SUFFIX}`;
      const lastObj = await this.env.R2.get(stateKey);
      const last: LastState = lastObj
        ? ((await lastObj.json()) as LastState)
        : { mirrored: {}, updatedAt: new Date(0).toISOString() };
      return { manifest, last };
    });

    const targets = filterTargets(manifest.items, params, last);

    const concurrency = clamp(
      params.concurrency ?? Number.parseInt(this.env.MAPTERHORN_SUPERVISOR_CONCURRENCY ?? "2", 10),
      1,
      8,
    );
    const maxItems = params.maxItems ?? Number.parseInt(this.env.MAPTERHORN_SUPERVISOR_MAX_ITEMS ?? "200", 10);
    if (targets.length > maxItems) {
      throw new Error(
        `refusing to mirror ${targets.length} items, exceeds maxItems=${maxItems}. Pass {maxItems: N} to override.`,
      );
    }

    if (targets.length === 0) {
      return { ok: true, manifestVersion: manifest.version, total: 0, results: {} };
    }

    const results: Record<string, { status: Terminal; md5: string; error?: string }> = {};

    const batches = chunk(targets, concurrency);
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]!;

      const spawned = await step.do(`spawn:batch-${b}`, async () => {
        const out: Array<{ name: string; id: string; md5: string }> = [];
        for (const item of batch) {
          const inst = await this.env.MAPTERHORN_MIRROR.create({ params: { archive: item.name } });
          out.push({ name: item.name, id: inst.id, md5: item.md5sum });
        }
        return out;
      });

      // Poll until every instance in this batch reaches a terminal
      // status. Each iteration is its own step so the parent workflow
      // sleeps durably between polls.
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
                terminal === "complete"
                  ? undefined
                  : safeErrorMessage(s) ?? terminal;
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
  p: MapterhornSupervisorParams,
  last: LastState,
): ManifestItem[] {
  let out = items;
  if (p.skipPlanet) out = out.filter((i) => i.name !== "planet.pmtiles");
  if (p.archives && p.archives.length > 0) {
    const allow = new Set(p.archives);
    out = out.filter((i) => allow.has(i.name));
  } else if (p.bbox) {
    const [minLon, minLat, maxLon, maxLat] = p.bbox;
    out = out.filter(
      (i) =>
        i.name === "planet.pmtiles" ||
        (i.max_lon >= minLon && i.min_lon <= maxLon && i.max_lat >= minLat && i.min_lat <= maxLat),
    );
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

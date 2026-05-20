// Orchestrator for steady-state mirror maintenance. Fires daily,
// picks a small number of z13+ regional archives by "oldest
// mirroredAt first, then shallow max_zoom first", and runs the
// executor against each in sequence.
//
// "Rotation" because the workflow rotates through every archive over
// time, advancing the `mirroredAt` clock on each one — combined with
// the executor's version-skip, that gives a self-balancing system:
// archives the upstream hasn't rebuilt are skipped in seconds (still
// advancing mirroredAt so rotation continues), and archives the
// upstream rebuilt land here on their next visit.
//
// Default 5 archives per invocation. Shallow z=13-only archives are
// ~232 MB and finish in <1 min cold; the rotation reaches every z=13
// archive worldwide in ~1 month at this pace.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  bboxIntersects,
  fetchUpstreamManifest,
  spawnAndPollMirror,
  type Bbox,
  type Terminal,
} from "./mapterhorn-orchestrator.js";

export interface MapterhornRotationParams {
  /** [minLon, minLat, maxLon, maxLat] — only consider archives whose bbox intersects. */
  bbox?: Bbox;
  /** Mirror more than the default in this invocation. */
  count?: number;
}

interface ExistingPointer {
  archive: string;
  version: string;
  key: string;
  size: number;
  upstream: string;
  mirroredAt: string;
}

interface Candidate {
  name: string;
  /** Epoch ms of last mirroredAt; 0 for never-mirrored (highest priority). */
  mirroredAt: number;
  /** Upstream max_zoom — shallow archives are mirrored first for fastest coverage win. */
  maxZoom: number;
}

const POLL_INTERVAL = "5 minutes";

export class MapterhornRotationWorkflow extends WorkflowEntrypoint<Env, MapterhornRotationParams> {
  override async run(event: WorkflowEvent<MapterhornRotationParams>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload ?? {};
    const envDefault = Number.parseInt(this.env.MAPTERHORN_ROTATION_DEFAULT_COUNT ?? "", 10);
    const requested = params.count ?? (Number.isFinite(envDefault) && envDefault > 0 ? envDefault : 5);
    const count = Math.max(1, Math.min(20, requested));

    const picks = await step.do("pick", async (): Promise<Candidate[]> => {
      const manifest = await fetchUpstreamManifest(this.env.MAPTERHORN_UPSTREAM_BASE);

      // Rotation never touches planet.pmtiles — that's the monthly cron's job.
      let candidates = manifest.items.filter((i) => i.name !== "planet.pmtiles");
      if (params.bbox) {
        candidates = candidates.filter((i) => bboxIntersects(i, params.bbox!));
      }

      // Look up each candidate's pointer to learn its mirroredAt.
      // ~457 R2 GETs in parallel — well within the per-step subrequest
      // budget (10k on Paid) and finishes in a couple seconds.
      const prefix = this.env.MAPTERHORN_MIRROR_PREFIX;
      const enriched = await Promise.all(
        candidates.map(async (i): Promise<Candidate> => {
          const obj = await this.env.R2.get(`${prefix}/${i.name}.latest.json`);
          const maxZoom = i.max_zoom;
          if (!obj) return { name: i.name, mirroredAt: 0, maxZoom };
          try {
            const p = (await obj.json()) as ExistingPointer;
            const ts = Date.parse(p.mirroredAt);
            return { name: i.name, mirroredAt: Number.isFinite(ts) ? ts : 0, maxZoom };
          } catch {
            return { name: i.name, mirroredAt: 0, maxZoom };
          }
        }),
      );

      // Sort key:
      //   1. mirroredAt ascending — unmirrored (0) and stalest get hit first.
      //   2. maxZoom ascending — among equally-stale archives, the
      //      shallow z=13-only ones are tiny (~232 MB avg) and cover
      //      the world for free, so we collapse the SLA blind-spot
      //      fastest by doing them before z=13..17 monsters (avg 90 GB).
      //   3. name — deterministic tiebreak so a step retry picks the
      //      same archive.
      enriched.sort(
        (a, b) =>
          a.mirroredAt - b.mirroredAt ||
          a.maxZoom - b.maxZoom ||
          a.name.localeCompare(b.name),
      );
      const picked = enriched.slice(0, count);
      console.log(
        JSON.stringify({
          event: "rotation_picked",
          count: picked.length,
          totalCandidates: enriched.length,
          archives: picked.map((p) => ({
            name: p.name,
            maxZoom: p.maxZoom,
            mirroredAt: p.mirroredAt === 0 ? null : new Date(p.mirroredAt).toISOString(),
          })),
        }),
      );
      return picked;
    });

    if (picks.length === 0) {
      return { ok: true, picked: [], note: "no candidates matched" };
    }

    const results: Array<{ name: string; status: Terminal; error?: string }> = [];
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i]!;
      const { terminal, errorMsg } = await spawnAndPollMirror(
        step,
        this.env.MAPTERHORN_MIRROR,
        pick.name,
        { stepPrefix: pick.name, pollInterval: POLL_INTERVAL },
      );
      const error = terminal === "complete" ? undefined : errorMsg || terminal;
      console.log(
        JSON.stringify({
          event: "rotation_child_done",
          archive: pick.name,
          status: terminal,
          error,
        }),
      );
      results.push({ name: pick.name, status: terminal, error });
    }

    return {
      ok: true,
      picked: picks.map((p) => p.name),
      results,
    };
  }
}

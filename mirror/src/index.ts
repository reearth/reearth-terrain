// Worker entry for the PMTiles mirrors.
//
// Two surfaces:
//   - `scheduled` (cron): dispatches the right Workflow based on which
//     cron fired (`event.cron`). Protomaps and Mapterhorn run on
//     different schedules so they don't compete for the upstream/R2
//     budget; see wrangler.toml `triggers.crons`.
//   - `fetch`: tiny HTTP API for manual ops. `/runs/{source}` starts a
//     run and reports status, `/latest/{source}` reads the pointer file.
//     All write endpoints require a bearer token (set via
//     `wrangler secret put MIRROR_TOKEN`).

import { PmtilesMirrorWorkflow } from "./workflow.js";
import { MapterhornMirrorWorkflow } from "./mapterhorn-workflow.js";
import { MapterhornSupervisorWorkflow } from "./supervisor-workflow.js";

export { PmtilesMirrorWorkflow, MapterhornMirrorWorkflow, MapterhornSupervisorWorkflow };

// Wired in wrangler.toml `triggers.crons`. Each cron maps to one
// source — the strings must stay in sync with the toml.
const PROTOMAPS_CRON = "0 3 1 * *";
const MAPTERHORN_CRON = "0 5 1 * *";

type Source = "protomaps" | "mapterhorn";

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === MAPTERHORN_CRON) {
      ctx.waitUntil(startMapterhornRun(env));
      return;
    }
    // Default to Protomaps so an unknown cron string still produces a
    // run rather than silently dropping the trigger.
    if (event.cron !== PROTOMAPS_CRON) {
      console.warn(JSON.stringify({ event: "mirror_unknown_cron", cron: event.cron }));
    }
    ctx.waitUntil(startProtomapsRun(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // GET /latest/{source} — pointer file for that source's most
    // recent successful mirror. Unauthenticated by design (read-only,
    // and the bucket itself isn't public).
    if (req.method === "GET" && parts[0] === "latest" && parts.length === 2) {
      const source = parseSource(parts[1] ?? "");
      if (!source) return json({ error: "unknown source" }, 404);
      const key = latestKey(env, source);
      const obj = await env.R2.get(key);
      if (!obj) return json({ error: "no mirror yet" }, 404);
      return new Response(obj.body, {
        headers: { "content-type": "application/json" },
      });
    }

    // Supervisor endpoints (POST /supervisor/mapterhorn, GET /supervisor/mapterhorn/{id}).
    // Kept separate from /runs because the supervisor isn't a tileset
    // source — it orchestrates many MAPTERHORN_MIRROR runs.
    if (req.method === "POST" && parts[0] === "supervisor" && parts[1] === "mapterhorn" && parts.length === 2) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const body = await readJson(req).catch(() => ({}));
      const params = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const instance = await env.MAPTERHORN_SUPERVISOR.create({ params });
      return json({ id: instance.id, status: await instance.status() }, 202);
    }
    if (req.method === "GET" && parts[0] === "supervisor" && parts[1] === "mapterhorn" && parts.length === 3) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const id = parts[2] ?? "";
      const instance = await env.MAPTERHORN_SUPERVISOR.get(id);
      return json({ id, status: await instance.status() });
    }

    if (req.method === "POST" && parts[0] === "runs" && parts.length === 2) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const source = parseSource(parts[1] ?? "");
      if (!source) return json({ error: "unknown source" }, 404);
      const body = await readJson(req).catch(() => ({}));
      const params = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const instance = await startRun(env, source, params);
      return json({ id: instance.id, status: await instance.status() }, 202);
    }

    if (req.method === "GET" && parts[0] === "runs" && parts.length === 3) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const source = parseSource(parts[1] ?? "");
      if (!source) return json({ error: "unknown source" }, 404);
      const id = parts[2] ?? "";
      const binding = workflowFor(env, source);
      const instance = await binding.get(id);
      return json({ id, status: await instance.status() });
    }

    return json({ error: "not found" }, 404);
  },
};

async function startProtomapsRun(env: Env): Promise<void> {
  const instance = await env.PMTILES_MIRROR.create({ params: {} });
  console.log(JSON.stringify({ event: "mirror_scheduled", source: "protomaps", id: instance.id }));
}

async function startMapterhornRun(env: Env): Promise<void> {
  // Scheduled run always mirrors `planet.pmtiles`. Regional z13+
  // archives are large enough that we expect them to be triggered
  // manually via POST /runs/mapterhorn.
  const instance = await env.MAPTERHORN_MIRROR.create({ params: {} });
  console.log(JSON.stringify({ event: "mirror_scheduled", source: "mapterhorn", id: instance.id }));
}

async function startRun(env: Env, source: Source, params: Record<string, unknown>) {
  if (source === "protomaps") {
    const date = typeof params.date === "string" ? params.date : undefined;
    return env.PMTILES_MIRROR.create({ params: { date } });
  }
  const archive = typeof params.archive === "string" ? params.archive : undefined;
  return env.MAPTERHORN_MIRROR.create({ params: { archive } });
}

function parseSource(s: string): Source | null {
  return s === "protomaps" || s === "mapterhorn" ? s : null;
}

function workflowFor(env: Env, source: Source): Workflow {
  return source === "protomaps" ? env.PMTILES_MIRROR : env.MAPTERHORN_MIRROR;
}

function latestKey(env: Env, source: Source): string {
  if (source === "protomaps") return `${env.MIRROR_PREFIX}/latest.json`;
  // Mapterhorn's pointer is per-archive; default to planet.pmtiles for
  // the no-arg `/latest/mapterhorn` lookup, which is what the scheduled
  // run produces. Regional pointers can be fetched directly from R2.
  return `${env.MAPTERHORN_MIRROR_PREFIX}/planet.pmtiles.latest.json`;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.MIRROR_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.MIRROR_TOKEN}`;
  // Constant-time-ish comparison — short token, isolated worker; not a
  // high-value attack surface.
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Worker entry for the PMTiles mirror.
//
// Two surfaces:
//   - `scheduled` (cron): kicks off the Workflow on the monthly trigger.
//   - `fetch`: tiny HTTP API for manual ops — start a run, look up a
//     run's status, read `latest.json`. All write endpoints require a
//     bearer token (set via `wrangler secret put MIRROR_TOKEN`).

import { PmtilesMirrorWorkflow } from "./workflow.js";

export { PmtilesMirrorWorkflow };

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(startRun(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/latest") {
      const obj = await env.R2.get(`${env.MIRROR_PREFIX}/latest.json`);
      if (!obj) return json({ error: "no mirror yet" }, 404);
      return new Response(obj.body, {
        headers: { "content-type": "application/json" },
      });
    }

    if (req.method === "POST" && url.pathname === "/runs") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const body = await readJson(req).catch(() => ({}));
      const params = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const date = typeof params.date === "string" ? params.date : undefined;
      const instance = await env.PMTILES_MIRROR.create({ params: { date } });
      return json({ id: instance.id, status: await instance.status() }, 202);
    }

    if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const id = url.pathname.slice("/runs/".length);
      const instance = await env.PMTILES_MIRROR.get(id);
      return json({ id, status: await instance.status() });
    }

    return json({ error: "not found" }, 404);
  },
};

async function startRun(env: Env): Promise<void> {
  const instance = await env.PMTILES_MIRROR.create({ params: {} });
  console.log(JSON.stringify({ event: "mirror_scheduled", id: instance.id }));
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

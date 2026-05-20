// Shared building blocks for the Mapterhorn orchestrator workflows
// (`MapterhornSweepWorkflow`, `MapterhornRotationWorkflow`). Both
// follow the same outline — fetch upstream manifest, filter, spawn
// `MapterhornMirrorWorkflow` instances, poll until terminal — but
// differ in selection strategy and concurrency shape. The pieces here
// are everything that doesn't differ.

import type { WorkflowStep } from "cloudflare:workers";

export interface ManifestItem {
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

export interface UpstreamManifest {
  version: string;
  items: ManifestItem[];
}

export type Bbox = [number, number, number, number];

export const MANIFEST_PATH = "/download_urls.json";

export async function fetchUpstreamManifest(base: string): Promise<UpstreamManifest> {
  const url = `${base}${MANIFEST_PATH}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  const m = (await r.json()) as UpstreamManifest;
  if (!Array.isArray(m.items)) throw new Error(`manifest.items is not an array`);
  return m;
}

export function bboxIntersects(item: ManifestItem, bbox: Bbox): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return (
    item.max_lon >= minLon &&
    item.min_lon <= maxLon &&
    item.max_lat >= minLat &&
    item.min_lat <= maxLat
  );
}

export type Terminal = "complete" | "errored" | "terminated";

export type SleepDuration = Parameters<WorkflowStep["sleep"]>[1];

/**
 * Spawn one `MapterhornMirrorWorkflow` run for `archive` and poll
 * until terminal. Both the spawn and each poll are their own
 * `step.do`, with `step.sleep` between polls — so the parent workflow
 * idles cheaply across the child's wall-clock lifetime.
 *
 * `stepPrefix` namespaces step names within the parent instance,
 * which is required to be unique. Callers that spawn many children
 * (sweep) must pass a distinct prefix per child.
 */
export async function spawnAndPollMirror(
  step: WorkflowStep,
  binding: Workflow,
  archive: string,
  options: { stepPrefix: string; pollInterval: SleepDuration },
): Promise<{ terminal: Terminal; errorMsg: string }> {
  const { stepPrefix, pollInterval } = options;

  const instanceId = await step.do(`${stepPrefix}:spawn`, async () => {
    const inst = await binding.create({ params: { archive } });
    return inst.id;
  });

  let iter = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await step.sleep(`${stepPrefix}:sleep:${iter}`, pollInterval);
    const result = await step.do(`${stepPrefix}:poll:${iter}`, async () => {
      const inst = await binding.get(instanceId);
      const s = await inst.status();
      if (s.status === "complete" || s.status === "errored" || s.status === "terminated") {
        const err = (s as { error?: unknown }).error;
        const errorMsg =
          err == null ? "" : typeof err === "string" ? err : JSON.stringify(err);
        return { terminal: s.status as Terminal, errorMsg };
      }
      return { terminal: null as Terminal | null, errorMsg: "" };
    });
    if (result.terminal) return { terminal: result.terminal, errorMsg: result.errorMsg };
    iter++;
  }
}

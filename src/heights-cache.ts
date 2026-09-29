// Remembering the height at a point, so the next caller who asks for it does
// not decode a DEM tile to find out.
//
// `/heights.json` was measured on 2026-09-29 at 99.4% of this Worker's CPU:
// about 936 ms a request, against 80 ms for a mesh tile that missed every
// cache. The reason is in src/sample.ts — each distinct tile a request touches
// is read and decoded whole, ~20 ms of WebP decoding, to bilinear-sample one
// point out of it, and a request of ~60 points touches ~47 tiles. Nothing a
// tile-level cache does about that helps much: the points are spread out, so
// even at z12 they land in ~38 tiles.
//
// What does help is that the callers ask the same questions. They are all
// server-side proxies of one app, run by many forks of it, sampling a 0.001°
// grid, and in a 72 s sample two thirds of the point references had been seen
// before somewhere, and one in seven at the same colo. So the answer is kept
// per point: in a small LRU in the isolate, and behind that in the colo's
// Cache API, the same shelf src/range-cache.ts uses for byte ranges.
//
// Only `elevation` and `geoid` are kept; `ellipsoid` is their sum, computed
// the same way src/sample.ts computes it, so a cached answer serialises to the
// same bytes as a fresh one.

import type { PointHeights, SamplePoint } from "./sample.js";
import { afford, refund } from "./range-cache.js";
import { resolveTilesetVersion, type Tileset } from "./tilesets.js";

/**
 * How long an answer is trusted, in both layers, counted from when it was
 * computed rather than from when a layer last stored it.
 *
 * The DEM under `MAPTERHORN_SOURCE = "hybrid"` changes in two ways. Tiles at
 * z ≤ 12 and in mirrored regional archives come from pinned snapshots with no
 * per-tile freshness at all: a mesh tile built from them is served until the
 * tileset version is bumped, and the version is in the key here too, so for
 * those points this cache is never staler than the tile path — it is fresher.
 * Tiles at z ≥ 13 outside the mirror come from tiles.mapterhorn.com, and there
 * the tile path trusts a cached tile for six hours and then asks upstream
 * whether it changed (`DEM_FRESHNESS_TTL_MS` in src/index.ts, `isStillFresh`
 * in src/cache.ts). Six hours here matches that window, so a regional rebuild
 * reaches a height no later than it reaches the tile covering it.
 *
 * Neither path can be fresher than the upstream fetch it builds from, which
 * the edge holds for a day (`cacheTtl` in `MapterhornSource`). That is
 * unchanged by this cache and is shared with the tile path.
 */
export const POINT_TTL_SECONDS = 6 * 60 * 60;

/**
 * Answers held in this isolate. One is a key of about sixty characters and
 * two numbers — a few hundred bytes with the map's own overhead — so this is
 * a few megabytes at most, next to the 32 MiB the decoded-tile LRUs in
 * src/dem.ts and src/mapterhorn-mirror.ts may hold. A request asks for ~60
 * points, so it is the last hundred-odd requests' worth.
 */
const POINT_LRU_CAPACITY = 8192;

interface Answer {
  elevation: number;
  geoid: number;
  /** When it was computed, in ms since the epoch. */
  at: number;
}

// Map preserves insertion order, so re-inserting on access promotes to most
// recently used and the first key is the one to evict — the same shape as the
// decoded-tile LRU in src/dem.ts.
const memory = new Map<string, Answer>();

/** Test-only: forget everything this isolate remembers. */
export function clearPointMemory(): void {
  memory.clear();
}

export interface PointStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultStore(): PointStore | null {
  const api = (globalThis as { caches?: { default?: PointStore } }).caches;
  return api?.default ?? null;
}

/** Where each point's answer came from, for the log line that measures this. */
export interface Served {
  memory: number;
  cache: number;
  computed: number;
}

export interface PointHeightsOptions {
  /** Work to run after the response, for the stores. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Answers for the points nobody has asked about yet. */
  compute: (points: SamplePoint[]) => Promise<PointHeights[]>;
  /** Skip both layers, as `DISABLE_CACHE` does for tiles. */
  disabled?: boolean;
  store?: PointStore | null;
  now?: () => number;
}

/**
 * A cache key for one point of one tileset.
 *
 * The DEM source's name is in it as well as the version: switching
 * `MAPTERHORN_SOURCE` is meant to come with a version bump, but a key that
 * does not depend on remembering that costs nothing.
 *
 * Coordinates are written as JavaScript's shortest round-trip form of the
 * parsed number, so `-97.61300` and `-97.613` share a key and nothing else
 * does. A fixed number of decimals would be tidier and wrong: two points that
 * differ past the last kept digit would share an answer that belongs to one of
 * them. `-0` prints as `0`, which samples identically.
 */
export function pointKey(tileset: Tileset, point: SamplePoint): string {
  const version = encodeURIComponent(resolveTilesetVersion(tileset));
  const dem = encodeURIComponent(tileset.dem.name);
  return `https://heights.reearth-terrain.internal/${tileset.name}/v${version}/${dem}/${String(point.lon)},${String(point.lat)}`;
}

/**
 * Heights at `points`, from memory, the colo's cache, or `compute`, in that
 * order, returned in the order asked.
 *
 * Each point that goes to the Cache API sets aside two operations from the
 * request's shared budget — a lookup, and a store in case it misses — and
 * gives the second back when it hits. A point the budget cannot cover is
 * computed and not stored, so a request is answered the same either way.
 */
export async function cachedPointHeights(
  tileset: Tileset,
  points: SamplePoint[],
  opts: PointHeightsOptions,
): Promise<{ heights: PointHeights[]; served: Served }> {
  const served: Served = { memory: 0, cache: 0, computed: 0 };
  if (opts.disabled) {
    served.computed = points.length;
    return { heights: await opts.compute(points), served };
  }

  const store = opts.store === undefined ? defaultStore() : opts.store;
  const now = opts.now ?? Date.now;
  const out: PointHeights[] = new Array(points.length);
  const keys = points.map((p) => pointKey(tileset, p));

  // Layer one: this isolate.
  const pending: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const hit = recall(keys[i]!, now());
    if (hit) {
      out[i] = heightsOf(hit);
      served.memory++;
    } else {
      pending.push(i);
    }
  }

  // Layer two: the colo, every point at once.
  const storable = new Set<number>();
  const missed: number[] = [];
  await Promise.all(
    pending.map(async (i) => {
      if (!store || !afford(2)) {
        missed.push(i);
        return;
      }
      storable.add(i);
      const hit = await lookup(store, keys[i]!, now());
      if (hit) {
        refund(1); // the store it was set aside for will not happen
        storable.delete(i);
        remember(keys[i]!, hit);
        out[i] = heightsOf(hit);
        served.cache++;
      } else {
        missed.push(i);
      }
    }),
  );
  if (missed.length === 0) return { heights: out, served };

  // Layer three: the DEM. One call for all the misses, so they are still
  // binned by tile the way src/sample.ts does it.
  missed.sort((a, b) => a - b);
  const computed = await opts.compute(missed.map((i) => points[i]!));
  const at = now();
  const puts: Promise<void>[] = [];
  const stored = new Set<string>();
  for (let j = 0; j < missed.length; j++) {
    const i = missed[j]!;
    const heights = computed[j]!;
    out[i] = heights;
    served.computed++;

    const answer = answerOf(heights, at);
    if (!answer) {
      // Budget set aside for a store that is not going to be made.
      if (storable.has(i)) refund(1);
      continue;
    }
    remember(keys[i]!, answer);
    if (!storable.has(i)) continue;
    // A point asked twice in one request is stored once.
    if (stored.has(keys[i]!)) {
      refund(1);
      continue;
    }
    stored.add(keys[i]!);
    puts.push(save(store!, keys[i]!, answer));
  }
  if (puts.length > 0) opts.waitUntil(Promise.all(puts));
  return { heights: out, served };
}

/**
 * The answer worth keeping, or null when there is not one.
 *
 * Only a complete answer is kept. The geoid is global, so a null geoid is
 * never the true answer: it is a raster read that threw and was swallowed in
 * `sampleGeoidAtPoints`. Elevation is null only when no zoom down to z0 had a
 * tile, and `planet.pmtiles` covers the world at z ≤ 12, so a null there means
 * the mirror pointer was missing or unreadable rather than that the ground is
 * not there. Both are worth asking again next time; keeping them would repeat
 * a failure for six hours. A read that throws never reaches here at all —
 * the request fails with a 500 and nothing is stored.
 */
function answerOf(h: PointHeights, at: number): Answer | null {
  if (h.elevation == null || h.geoid == null) return null;
  return { elevation: h.elevation, geoid: h.geoid, at };
}

function heightsOf(a: Answer): PointHeights {
  return { elevation: a.elevation, geoid: a.geoid, ellipsoid: a.elevation + a.geoid };
}

function recall(key: string, now: number): Answer | null {
  const hit = memory.get(key);
  if (!hit) return null;
  memory.delete(key);
  if (!isFresh(hit, now)) return null;
  memory.set(key, hit);
  return hit;
}

function remember(key: string, answer: Answer): void {
  memory.delete(key);
  memory.set(key, answer);
  if (memory.size > POINT_LRU_CAPACITY) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}

/**
 * Checked on every read, in both layers, because the Cache API's own expiry
 * counts from when an entry was stored, and an answer copied from the colo
 * into memory would otherwise start its six hours over.
 */
function isFresh(a: Answer, now: number): boolean {
  return now - a.at < POINT_TTL_SECONDS * 1000;
}

async function lookup(store: PointStore, key: string, now: number): Promise<Answer | null> {
  try {
    const hit = await store.match(new Request(key));
    if (!hit) return null;
    const body = (await hit.json()) as Partial<Answer> | null;
    if (
      typeof body?.elevation !== "number"
      || typeof body.geoid !== "number"
      || typeof body.at !== "number"
    ) {
      return null;
    }
    const answer = { elevation: body.elevation, geoid: body.geoid, at: body.at };
    return isFresh(answer, now) ? answer : null;
  } catch {
    // A cache that cannot be read is not a reason to fail the request.
    return null;
  }
}

async function save(store: PointStore, key: string, answer: Answer): Promise<void> {
  try {
    await store.put(
      new Request(key),
      new Response(JSON.stringify(answer), {
        headers: {
          "Cache-Control": `public, max-age=${POINT_TTL_SECONDS}`,
          "Content-Type": "application/json",
        },
      }),
    );
  } catch {
    // Storing is best effort; the answer has already been served.
  }
}

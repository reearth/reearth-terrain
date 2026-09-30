// The per-point heights cache is only worth having if a cached answer is the
// answer: same numbers, same order, same bytes once serialised. These tests
// pin that, and the three ways it could quietly go wrong — keeping a failure,
// outliving the DEM's freshness window, and spending subrequests the request
// does not have.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PINNED_TTL_SECONDS,
  REVALIDATED_TTL_SECONDS,
  cachedPointHeights,
  clearPointMemory,
  pointKey,
  type PointStore,
} from "./heights-cache.js";
import { budgetLeft, withRangeCache } from "./range-cache.js";
import type { PointHeights, SamplePoint } from "./sample.js";
import { parsePointsParam } from "./sample.js";
import type { Tileset } from "./tilesets.js";

const tileset = {
  name: "mapterhorn-egm08",
  version: "7",
  dem: { name: "mapterhorn-hybrid" },
} as unknown as Tileset;

/** A stand-in for `caches.default` that remembers what it was given. */
function store() {
  const held = new Map<string, string>();
  const match = vi.fn(async (req: Request) => {
    const hit = held.get(req.url);
    return hit === undefined ? undefined : new Response(hit);
  });
  const put = vi.fn(async (req: Request, res: Response) => {
    held.set(req.url, await res.text());
  });
  const cache: PointStore = { match, put };
  return { cache, match, put, held };
}

/** Heights that are arithmetic in the coordinates, so any mix-up shows. */
function fakeSample(p: SamplePoint): PointHeights {
  const elevation = p.lon * 10 + p.lat / 3;
  const geoid = p.lat / 7;
  return { elevation, geoid, ellipsoid: elevation + geoid };
}

function computer(answer: (p: SamplePoint) => PointHeights = fakeSample) {
  return vi.fn(async (points: SamplePoint[]) => points.map(answer));
}

/** Run one request's worth, and wait for the stores it left behind. */
async function ask(
  points: SamplePoint[],
  opts: {
    compute: (points: SamplePoint[]) => Promise<PointHeights[]>;
    cache?: PointStore | null;
    now?: () => number;
    disabled?: boolean;
  },
) {
  const later: Promise<unknown>[] = [];
  const result = await cachedPointHeights(tileset, points, {
    waitUntil: (p) => later.push(p),
    compute: opts.compute,
    store: opts.cache ?? null,
    now: opts.now,
    disabled: opts.disabled,
  });
  await Promise.all(later);
  return result;
}

const pts = (raw: string) => parsePointsParam(raw);

beforeEach(() => clearPointMemory());

describe("pointKey", () => {
  it("gives equal points the same key however they were written", () => {
    const [a, b] = pts("-97.61300,38.79300;-97.613,38.793");
    expect(pointKey(tileset, a!)).toBe(pointKey(tileset, b!));
    expect(pointKey(tileset, a!)).toBe(
      "https://heights.reearth-terrain.internal/mapterhorn-egm08/v7/mapterhorn-hybrid/-97.613,38.793",
    );
  });

  it("keeps points apart that differ past the fifth decimal", () => {
    const [a, b] = pts("139.00001,35;139.000011,35");
    expect(pointKey(tileset, a!)).not.toBe(pointKey(tileset, b!));
  });

  it("changes with the tileset version and the DEM source", () => {
    const p = { lon: 1, lat: 2 };
    const bumped = { ...tileset, version: "8" } as Tileset;
    const mirror = { ...tileset, dem: { name: "mapterhorn-mirror" } } as unknown as Tileset;
    const geoid = { ...tileset, geoidVersion: "2" } as Tileset;
    const keys = new Set([tileset, bumped, mirror, geoid].map((t) => pointKey(t, p)));
    expect(keys.size).toBe(4);
  });
});

describe("cachedPointHeights", () => {
  it("serves a repeat from memory with the same numbers", async () => {
    const points = pts("139.7,35.7;-97.613,38.793");
    const compute = computer();

    const first = await withRangeCache(() => ask(points, { compute }));
    const second = await withRangeCache(() => ask(points, { compute }));

    expect(compute).toHaveBeenCalledTimes(1);
    expect(first.served).toEqual({ memory: 0, cache: 0, computed: 2 });
    expect(second.served).toEqual({ memory: 2, cache: 0, computed: 0 });
    expect(second.heights).toEqual(points.map(fakeSample));
    // Serialised, as the response body is, the two cannot be told apart.
    expect(JSON.stringify(second.heights)).toBe(JSON.stringify(first.heights));
  });

  it("serves from the colo's cache when this isolate has forgotten", async () => {
    const points = pts("139.7,35.7;-97.613,38.793");
    const { cache, put } = store();
    const compute = computer();

    const first = await withRangeCache(() => ask(points, { compute, cache }));
    expect(put).toHaveBeenCalledTimes(2);

    clearPointMemory();
    const second = await withRangeCache(() => ask(points, { compute, cache }));
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second.served).toEqual({ memory: 0, cache: 2, computed: 0 });
    expect(JSON.stringify(second.heights)).toBe(JSON.stringify(first.heights));
  });

  it("computes only the misses, in one call, and answers in the order asked", async () => {
    const compute = computer();
    await withRangeCache(() => ask(pts("1,1;3,3"), { compute }));

    const all = pts("0,0;1,1;2,2;3,3;4,4");
    const out = await withRangeCache(() => ask(all, { compute }));

    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1]![0]).toEqual(pts("0,0;2,2;4,4"));
    expect(out.heights).toEqual(all.map(fakeSample));
    expect(out.served).toEqual({ memory: 2, cache: 0, computed: 3 });
  });

  it("does not keep an answer with a null in it", async () => {
    // A null geoid is a raster read that failed, and a null elevation is a
    // missing mirror pointer; neither should be repeated for six hours.
    const { cache, put } = store();
    const compute = computer((p) =>
      p.lon === 0
        ? { elevation: null, geoid: 36.7, ellipsoid: null }
        : { elevation: 12, geoid: null, ellipsoid: null },
    );
    const points = pts("0,0;1,1");

    await withRangeCache(() => ask(points, { compute, cache }));
    const again = await withRangeCache(() => ask(points, { compute, cache }));

    expect(put).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(again.served.computed).toBe(2);
    expect(again.heights[0]).toEqual({ elevation: null, geoid: 36.7, ellipsoid: null });
  });

  it("does not store anything when the computation throws", async () => {
    const { cache, put } = store();
    const compute = vi.fn(async () => {
      throw new Error("mapterhorn fetch -> 503");
    });
    await expect(
      withRangeCache(() => ask(pts("0,0"), { compute, cache })),
    ).rejects.toThrow(/503/);
    expect(put).not.toHaveBeenCalled();
  });

  it("recomputes once an answer is older than the freshness window, in both layers", async () => {
    const { cache } = store();
    const compute = computer();
    const points = pts("139.7,35.7");
    let t = 1_000_000;
    const now = () => t;

    await withRangeCache(() => ask(points, { compute, cache, now }));

    t += REVALIDATED_TTL_SECONDS * 1000 - 1;
    const warm = await withRangeCache(() => ask(points, { compute, cache, now }));
    expect(warm.served.memory).toBe(1);

    // Past the window, neither the isolate's copy nor the colo's is used,
    // even though the colo's entry may not have expired by its own clock.
    t += 1;
    const stale = await withRangeCache(() => ask(points, { compute, cache, now }));
    expect(stale.served).toEqual({ memory: 0, cache: 0, computed: 1 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("does not let a copy from the colo start its window over", async () => {
    const { cache } = store();
    const compute = computer();
    const points = pts("139.7,35.7");
    let t = 1_000_000;
    const now = () => t;

    await withRangeCache(() => ask(points, { compute, cache, now }));
    clearPointMemory();
    t += REVALIDATED_TTL_SECONDS * 1000 - 10;
    const fromColo = await withRangeCache(() => ask(points, { compute, cache, now }));
    expect(fromColo.served.cache).toBe(1);

    t += 10;
    const stale = await withRangeCache(() => ask(points, { compute, cache, now }));
    expect(stale.served.computed).toBe(1);
  });

  it("keeps an answer from a pinned tile for a week, and one from a rechecked tile for six hours", async () => {
    const { cache, held } = store();
    const pinned = pts("139.7,35.7");
    const moving = pts("10,10");
    const compute = computer((p) => ({ ...fakeSample(p), revalidated: p.lon === 10 }));
    let t = 1_000_000;
    const now = () => t;

    await withRangeCache(() => ask([...pinned, ...moving], { compute, cache, now }));
    const ages = [...held.values()].map((body) => JSON.parse(body).ttl).sort((a, b) => a - b);
    expect(ages).toEqual([REVALIDATED_TTL_SECONDS, PINNED_TTL_SECONDS]);

    clearPointMemory();
    t += REVALIDATED_TTL_SECONDS * 1000;
    const later = await withRangeCache(() => ask([...pinned, ...moving], { compute, cache, now }));
    expect(later.served).toEqual({ memory: 0, cache: 1, computed: 1 });

    clearPointMemory();
    t += (PINNED_TTL_SECONDS - REVALIDATED_TTL_SECONDS) * 1000;
    const week = await withRangeCache(() => ask(pinned, { compute, cache, now }));
    expect(week.served.computed).toBe(1);
  });

  it("stores each answer for as long as it is trusted", async () => {
    const { cache, put } = store();
    const compute = computer((p) => ({ ...fakeSample(p), revalidated: false }));

    await withRangeCache(() => ask(pts("139.7,35.7"), { compute, cache }));
    const stored = put.mock.calls[0]![1] as Response;
    expect(stored.headers.get("Cache-Control")).toBe(`public, max-age=${PINNED_TTL_SECONDS}`);
  });

  it("reads an answer stored before the TTL depended on the source as a six-hour one", async () => {
    const { cache, held } = store();
    const compute = computer();
    const points = pts("139.7,35.7");
    let t = 1_000_000;
    const now = () => t;
    const { elevation, geoid } = fakeSample(points[0]!);
    held.set(pointKey(tileset, points[0]!), JSON.stringify({ elevation, geoid, at: t }));

    t += REVALIDATED_TTL_SECONDS * 1000 - 1;
    const warm = await withRangeCache(() => ask(points, { compute, cache, now }));
    expect(warm.served.cache).toBe(1);

    clearPointMemory();
    t += 1;
    const stale = await withRangeCache(() => ask(points, { compute, cache, now }));
    expect(stale.served.computed).toBe(1);
  });

  it("sets aside a lookup and a store per point, and gives back what a hit did not use", async () => {
    const { cache } = store();
    const compute = computer();
    const points = pts("0,0;1,1;2,2");

    await withRangeCache(async () => {
      const before = budgetLeft()!;
      await ask(points, { compute, cache });
      expect(budgetLeft()).toBe(before - 2 * points.length);
    });

    clearPointMemory();
    await withRangeCache(async () => {
      const before = budgetLeft()!;
      await ask(points, { compute, cache });
      expect(budgetLeft()).toBe(before - points.length);
    });
  });

  it("answers past the budget without touching the cache", async () => {
    const { cache, match, put } = store();
    const compute = computer();
    const many = Array.from({ length: 400 }, (_, i) => ({ lon: i, lat: 0 }));

    const out = await withRangeCache(() => ask(many, { compute, cache }));

    expect(out.heights).toEqual(many.map(fakeSample));
    expect(match.mock.calls.length).toBeLessThan(many.length);
    expect(put.mock.calls.length).toBe(match.mock.calls.length);
  });

  it("does not touch the colo's cache outside a request", async () => {
    const { cache, match } = store();
    const compute = computer();
    const out = await ask(pts("0,0"), { compute, cache });
    expect(out.served.computed).toBe(1);
    expect(match).not.toHaveBeenCalled();
  });

  it("answers when the cache throws", async () => {
    const cache: PointStore = {
      match: vi.fn(async () => {
        throw new Error("cache is having a day");
      }),
      put: vi.fn(async () => {
        throw new Error("cache is having a day");
      }),
    };
    const compute = computer();
    const points = pts("5,5");
    const out = await withRangeCache(() => ask(points, { compute, cache }));
    expect(out.heights).toEqual(points.map(fakeSample));
  });

  it("stores a point asked twice in one request once", async () => {
    const { cache, put } = store();
    const compute = computer();
    const out = await withRangeCache(() => ask(pts("7,7;7.000,7.0"), { compute, cache }));
    expect(out.heights).toEqual([fakeSample({ lon: 7, lat: 7 }), fakeSample({ lon: 7, lat: 7 })]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("bypasses both layers when caching is disabled", async () => {
    const { cache, match } = store();
    const compute = computer();
    const points = pts("0,0");
    await withRangeCache(() => ask(points, { compute, cache, disabled: true }));
    const again = await withRangeCache(() => ask(points, { compute, cache, disabled: true }));
    expect(again.served).toEqual({ memory: 0, cache: 0, computed: 1 });
    expect(match).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

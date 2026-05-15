import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup } from "./cleanup.js";

// Minimal R2Bucket mock backed by a sorted key set. Implements just the
// surface runCleanup uses: `list({prefix, delimiter, cursor, limit})` and
// `delete(keys[])`. Pagination is honoured so the maxDeletes / truncation
// path is exercisable.
function makeBucket(initial: Iterable<string> = []) {
  const keys = new Set<string>(initial);

  const list = vi.fn(async (opts?: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const prefix = opts?.prefix ?? "";
    const delimiter = opts?.delimiter;
    const limit = opts?.limit ?? 1000;
    const startAfter = opts?.cursor ?? "";

    const sorted = [...keys].filter((k) => k.startsWith(prefix)).sort();

    if (delimiter) {
      const seen = new Set<string>();
      for (const k of sorted) {
        const rest = k.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) seen.add(prefix + rest.slice(0, idx + 1));
      }
      const prefixes = [...seen].sort();
      return {
        objects: [],
        delimitedPrefixes: prefixes,
        truncated: false,
      };
    }

    const after = sorted.filter((k) => k > startAfter);
    const page = after.slice(0, limit);
    const truncated = after.length > limit;
    return {
      objects: page.map((key) => ({ key })),
      delimitedPrefixes: [],
      truncated,
      cursor: truncated ? page[page.length - 1] : undefined,
    };
  });

  const del = vi.fn(async (input: string | string[]) => {
    const arr = Array.isArray(input) ? input : [input];
    for (const k of arr) keys.delete(k);
  });

  const bucket = { list, delete: del } as unknown as R2Bucket;
  return { bucket, list, delete: del, keys };
}

function tileKeys(tileset: string, version: string, count: number, startZ = 0): string[] {
  // Synthesize unique-ish keys under the standard cache path.
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const z = startZ + Math.floor(i / 100);
    const x = i % 100;
    out.push(`cache/terrain/${tileset}/v${version}/terrarium/elevation/${z}/${x}/0.webp`);
  }
  return out;
}

describe("runCleanup", () => {
  const TILESETS = {
    "mapterhorn-egm08": { name: "mapterhorn-egm08", version: "4" },
  };

  it("keeps live versions and deletes stale ones", async () => {
    const { bucket, keys, delete: del } = makeBucket([
      ...tileKeys("mapterhorn-egm08", "4", 3),
      ...tileKeys("mapterhorn-egm08", "3", 5),
      ...tileKeys("mapterhorn-egm08", "2", 2),
    ]);

    const res = await runCleanup(bucket, TILESETS);

    expect(res.deleted).toBe(7);
    expect(res.truncated).toBe(false);
    expect(res.staleVersionPrefixes).toEqual([
      "cache/terrain/mapterhorn-egm08/v2/",
      "cache/terrain/mapterhorn-egm08/v3/",
    ]);
    // Live v4 keys remain.
    for (const k of tileKeys("mapterhorn-egm08", "4", 3)) {
      expect(keys.has(k)).toBe(true);
    }
    // Stale v2/v3 are gone.
    for (const k of tileKeys("mapterhorn-egm08", "3", 5)) expect(keys.has(k)).toBe(false);
    for (const k of tileKeys("mapterhorn-egm08", "2", 2)) expect(keys.has(k)).toBe(false);
    expect(del).toHaveBeenCalled();
  });

  it("deletes a whole tileset directory when the name is no longer registered", async () => {
    const { bucket, keys } = makeBucket([
      ...tileKeys("mapterhorn-egm08", "4", 2),
      ...tileKeys("old-tileset", "1", 3),
      ...tileKeys("old-tileset", "9", 1),
    ]);

    const res = await runCleanup(bucket, TILESETS);

    expect(res.deleted).toBe(4);
    expect(res.staleVersionPrefixes).toContain("cache/terrain/old-tileset/");
    // No drill-down — the tileset directory itself is targeted.
    expect(res.staleVersionPrefixes).not.toContain("cache/terrain/old-tileset/v1/");
    expect([...keys].some((k) => k.includes("/old-tileset/"))).toBe(false);
  });

  it("is a no-op when only live versions exist", async () => {
    const { bucket, keys, delete: del } = makeBucket([
      ...tileKeys("mapterhorn-egm08", "4", 4),
    ]);

    const res = await runCleanup(bucket, TILESETS);

    expect(res.deleted).toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.staleVersionPrefixes).toEqual([]);
    expect(keys.size).toBe(4);
    expect(del).not.toHaveBeenCalled();
  });

  it("respects maxDeletes and reports truncated", async () => {
    const { bucket, keys } = makeBucket([
      ...tileKeys("mapterhorn-egm08", "4", 2),
      ...tileKeys("mapterhorn-egm08", "3", 10),
    ]);

    const res = await runCleanup(bucket, TILESETS, { maxDeletes: 4 });

    expect(res.deleted).toBe(4);
    expect(res.truncated).toBe(true);
    // Live untouched.
    for (const k of tileKeys("mapterhorn-egm08", "4", 2)) expect(keys.has(k)).toBe(true);
    // 4 stale deleted, 6 stale remain → a second invocation would finish them.
    const remainingStale = [...keys].filter((k) => k.includes("/v3/"));
    expect(remainingStale.length).toBe(6);
  });

  it("pages through stale keys beyond a single list page", async () => {
    // 1500 stale keys forces two list pages (LIST_PAGE = 1000).
    const { bucket, list } = makeBucket([
      ...tileKeys("mapterhorn-egm08", "4", 1),
      ...tileKeys("mapterhorn-egm08", "3", 1500),
    ]);

    const res = await runCleanup(bucket, TILESETS, { maxDeletes: 2000 });

    expect(res.deleted).toBe(1500);
    expect(res.truncated).toBe(false);
    // First list = top-level delimited, second = tileset delimited, then
    // at least two non-delimited pages for v3/.
    const nonDelimitedCalls = list.mock.calls.filter((c) => !c[0]?.delimiter);
    expect(nonDelimitedCalls.length).toBeGreaterThanOrEqual(2);
  });
});

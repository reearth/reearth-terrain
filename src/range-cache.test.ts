import { describe, expect, it, vi } from "vitest";

import { budgetLeft, cachedRange, rangeKey, withRangeCache } from "./range-cache.js";

/** A stand-in for `caches.default` that remembers what it was given. */
function store() {
  const held = new Map<string, ArrayBuffer>();
  const match = vi.fn(async (req: Request) => {
    const hit = held.get(req.url);
    return hit ? new Response(hit.slice(0)) : undefined;
  });
  const put = vi.fn(async (req: Request, res: Response) => {
    held.set(req.url, await res.arrayBuffer());
  });
  return { cache: { match, put }, match, put, held };
}

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill).buffer;

describe("rangeKey", () => {
  it("names a range by its object and its offsets", () => {
    expect(rangeKey("sources/egm08_cog.tif", 4096, 512)).toBe(
      "https://range.reearth-terrain.internal/sources%2Fegm08_cog.tif?o=4096&l=512",
    );
  });

  it("keeps two ranges of one object apart", () => {
    expect(rangeKey("a", 0, 10)).not.toBe(rangeKey("a", 10, 10));
    expect(rangeKey("a", 0, 10)).not.toBe(rangeKey("b", 0, 10));
  });
});

describe("cachedRange", () => {
  it("reads once and serves the rest from the cache", async () => {
    const { cache, put } = store();
    const read = vi.fn(async () => bytes(8, 7));

    await withRangeCache(async () => {
      const first = await cachedRange("k", 0, 8, read, cache);
      const second = await cachedRange("k", 0, 8, read, cache);
      expect(new Uint8Array(first)).toEqual(new Uint8Array(bytes(8, 7)));
      expect(new Uint8Array(second)).toEqual(new Uint8Array(bytes(8, 7)));
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("does not confuse one range with another", async () => {
    const { cache } = store();
    const read = vi.fn(async (fill: number) => bytes(4, fill));

    await withRangeCache(async () => {
      const a = await cachedRange("k", 0, 4, () => read(1), cache);
      const b = await cachedRange("k", 4, 4, () => read(2), cache);
      expect(new Uint8Array(a)[0]).toBe(1);
      expect(new Uint8Array(b)[0]).toBe(2);
    });
  });

  it("stops using the cache once the request has spent its budget", async () => {
    // The Cache API shares the subrequest quota, and a scattered request was
    // measured making 628 reads. Past the budget the read still happens; it
    // is simply not helped.
    const { cache, match } = store();
    const read = vi.fn(async () => bytes(4, 1));

    await withRangeCache(async () => {
      let spent = 0;
      while (budgetLeft()! >= 2) {
        await cachedRange("k", spent++, 4, read, cache);
      }
      expect(budgetLeft()).toBeLessThan(2);

      const calls = match.mock.calls.length;
      const after = await cachedRange("k", 99999, 4, read, cache);
      expect(new Uint8Array(after)[0]).toBe(1); // still the right bytes
      expect(match.mock.calls.length).toBe(calls); // but no cache call
    });
  });

  it("reads straight through when there is no cache at all", async () => {
    const read = vi.fn(async () => bytes(4, 3));
    const out = await withRangeCache(() => cachedRange("k", 0, 4, read, null));
    expect(new Uint8Array(out)[0]).toBe(3);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads straight through outside a request, where there is no budget", async () => {
    const { cache, match } = store();
    const read = vi.fn(async () => bytes(4, 4));
    await cachedRange("k", 0, 4, read, cache);
    expect(read).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
  });

  it("serves the bytes even when the cache throws", async () => {
    // A cache that cannot be read or written is not a reason to fail.
    const cache = {
      match: vi.fn(async () => {
        throw new Error("cache is having a day");
      }),
      put: vi.fn(async () => {
        throw new Error("cache is having a day");
      }),
    };
    const read = vi.fn(async () => bytes(4, 9));

    const out = await withRangeCache(() => cachedRange("k", 0, 4, read, cache));
    expect(new Uint8Array(out)[0]).toBe(9);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("gives each request its own budget", async () => {
    await withRangeCache(async () => {
      const outer = budgetLeft();
      await withRangeCache(async () => {
        expect(budgetLeft()).toBe(outer);
      });
    });
  });
});

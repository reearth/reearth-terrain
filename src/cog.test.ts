import { describe, expect, it, vi } from "vitest";
import { openCog } from "./cog.js";

// A minimal R2Bucket fake. We only need `.get` for openCog's read path.
// Returning `null` from get() makes R2CogSource throw "object not found",
// which propagates out of GeoTIFF.fromSource — that's enough to observe the
// single-flight + cache-clear-on-error semantics without a real COG fixture.
function fakeBucket(get: (key: string) => Promise<R2ObjectBody | null>): R2Bucket {
  return {
    get: vi.fn(get),
    head: vi.fn(async () => null),
  } as unknown as R2Bucket;
}

describe("openCog", () => {
  it("shares one in-flight load between concurrent callers for the same key", async () => {
    const get = vi.fn(async () => null as unknown as R2ObjectBody);
    const bucket = fakeBucket(get);
    const key = "cog/concurrent.tif";

    const [a, b] = await Promise.allSettled([
      openCog(bucket, key),
      openCog(bucket, key),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    // The two callers must have observed the *same* rejected promise —
    // openCog memoizes by key, so the second call piggybacks on the first.
    // Concretely: R2.get is invoked at most once before both fail.
    expect((bucket.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("clears the cache on failure so a retry re-attempts the open", async () => {
    const get = vi.fn(async () => null as unknown as R2ObjectBody);
    const bucket = fakeBucket(get);
    const key = "cog/retry.tif";

    await expect(openCog(bucket, key)).rejects.toThrow();
    await expect(openCog(bucket, key)).rejects.toThrow();
    // Both calls reached R2 — the cached rejected promise was evicted,
    // so the second call started a new attempt.
    expect((bucket.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

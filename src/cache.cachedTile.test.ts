import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedTile, type GeneratedTile, type TileCacheParams } from "./cache.js";

const params: TileCacheParams = {
  tileset: "test",
  version: "1",
  encoding: "terrarium",
  dataType: "elevation",
  z: 5,
  x: 1,
  y: 2,
  format: "webp",
};

function tile(bytes = new Uint8Array([1, 2, 3, 4]), contentType = "image/webp"): GeneratedTile {
  return { bytes, contentType };
}

function req(headers: HeadersInit = {}): Request {
  return new Request("https://example.test/tile", { headers });
}

// Drain the cache + R2 cache prefix between tests so L1/L2 state from one
// test doesn't bleed into the next. We use distinct (tileset, x, y) tuples
// for most tests as belt-and-braces.
//
// The L1 key buildCacheKey() uses includes /v{version}/ — match that shape
// exactly here or the delete is a no-op and L1 entries leak across tests.
async function clearCache(p: TileCacheParams): Promise<void> {
  const path = `/${p.tileset}/v${p.version}/${p.encoding}/${p.dataType}/${p.z}/${p.x}/${p.y}.${p.format}`;
  await caches.default.delete(new Request(`https://example.test${path}`));
}

describe("cachedTile", () => {
  // R2 mock that records puts so we can assert L2 writes happened.
  let r2: R2Bucket;
  let r2Puts: { key: string; body: Uint8Array; contentType?: string; contentEncoding?: string }[];

  beforeEach(() => {
    r2Puts = [];
    const data = new Map<string, { body: Uint8Array; contentType?: string; contentEncoding?: string; uploaded: Date }>();
    r2 = {
      async get(key: string) {
        const v = data.get(key);
        if (!v) return null;
        return {
          arrayBuffer: async () => v.body.buffer.slice(v.body.byteOffset, v.body.byteOffset + v.body.byteLength),
          httpMetadata: { contentType: v.contentType, contentEncoding: v.contentEncoding },
          uploaded: v.uploaded,
        } as unknown as R2ObjectBody;
      },
      async put(key: string, body: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: R2HTTPMetadata }) {
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
        data.set(key, {
          body: bytes,
          contentType: opts?.httpMetadata?.contentType,
          contentEncoding: opts?.httpMetadata?.contentEncoding,
          uploaded: new Date(),
        });
        r2Puts.push({
          key,
          body: bytes,
          contentType: opts?.httpMetadata?.contentType,
          contentEncoding: opts?.httpMetadata?.contentEncoding,
        });
      },
    } as unknown as R2Bucket;
    // Test seam: lets a test reach in and back-date a stored entry so it
    // crosses the freshness TTL boundary without us having to fast-forward
    // the clock.
    (r2 as unknown as { _backdate: (key: string, uploaded: Date) => void })._backdate = (key, uploaded) => {
      const v = data.get(key);
      if (v) data.set(key, { ...v, uploaded });
    };
  });

  afterEach(async () => {
    // Ensure the Cache API entry written by previous tests doesn't survive.
    // The gzip test uses format="terrain"; the others use the default.
    for (const x of [1, 2, 3, 4, 5]) {
      for (const format of [params.format, "terrain"]) {
        await clearCache({ ...params, x, format });
      }
    }
  });

  it("short-circuits with 304 when If-None-Match matches the weak ETag", async () => {
    const p = { ...params, x: 10 };
    const ctx = createExecutionContext();
    const gen = vi.fn(async () => tile());
    // First call to learn the ETag.
    const first = await cachedTile(req(), ctx, r2, p, gen);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    await waitOnExecutionContext(ctx);

    // Clear L1 to prove the 304 came from the If-None-Match short-circuit,
    // not from an L1 hit that happens to also re-emit the ETag.
    await clearCache(p);

    const ctx2 = createExecutionContext();
    const gen2 = vi.fn(async () => tile());
    const second = await cachedTile(req({ "if-none-match": etag }), ctx2, r2, p, gen2);
    expect(second.status).toBe(304);
    expect(second.headers.get("x-cache")).toBe("304");
    expect(gen2).not.toHaveBeenCalled();
  });

  it("MISS: calls generate, sets x-cache=MISS, and writes to L1 + L2", async () => {
    const ctx = createExecutionContext();
    const gen = vi.fn(async () => tile(new Uint8Array([9, 9, 9])));
    const p = { ...params, x: 1 };
    const resp = await cachedTile(req(), ctx, r2, p, gen);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-cache")).toBe("MISS");
    expect(resp.headers.get("etag")).toMatch(/^W\//);
    expect(resp.headers.get("x-tileset")).toBe(`${p.tileset}@${p.version}`);
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
    expect(gen).toHaveBeenCalledOnce();

    // L1 + L2 writes are dispatched via ctx.waitUntil — drain before asserting.
    await waitOnExecutionContext(ctx);
    expect(r2Puts).toHaveLength(1);
    expect(r2Puts[0]!.key).toContain(`/${p.tileset}/v${p.version}/`);
  });

  it("L1 hit: second request for the same URL returns x-cache=L1 without calling generate", async () => {
    const p = { ...params, x: 2 };
    const ctx1 = createExecutionContext();
    const gen1 = vi.fn(async () => tile(new Uint8Array([7, 7, 7])));
    await cachedTile(req(), ctx1, r2, p, gen1);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    const gen2 = vi.fn(async () => tile(new Uint8Array([8, 8, 8])));
    const resp = await cachedTile(req(), ctx2, r2, p, gen2);
    expect(resp.headers.get("x-cache")).toBe("L1");
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
    expect(gen2).not.toHaveBeenCalled();
  });

  it("L2 hit: after clearing the Cache API, R2 serves the tile with x-cache=L2", async () => {
    const p = { ...params, x: 3 };
    // Seed via a MISS, then drop the L1 entry so the next read has to fall to L2.
    const ctx1 = createExecutionContext();
    await cachedTile(req(), ctx1, r2, p, vi.fn(async () => tile(new Uint8Array([4, 5, 6]))));
    await waitOnExecutionContext(ctx1);
    await clearCache(p);

    const ctx2 = createExecutionContext();
    const gen = vi.fn(async () => tile());
    const resp = await cachedTile(req(), ctx2, r2, p, gen);
    expect(resp.headers.get("x-cache")).toBe("L2");
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    expect(gen).not.toHaveBeenCalled();
  });

  it("disable=true bypasses both caches and emits x-cache=BYPASS", async () => {
    const p = { ...params, x: 4 };
    const ctx = createExecutionContext();
    const gen = vi.fn(async () => tile(new Uint8Array([1])));
    const resp = await cachedTile(req(), ctx, r2, p, gen, true);
    expect(resp.headers.get("x-cache")).toBe("BYPASS");
    await waitOnExecutionContext(ctx);
    expect(r2Puts).toHaveLength(0);
    expect(gen).toHaveBeenCalledOnce();
  });

  it("forwards contentEncoding (e.g. gzip) end-to-end on a MISS and round-trips through R2", async () => {
    const p = { ...params, x: 5, format: "terrain" };
    const ctx1 = createExecutionContext();
    const gen1 = vi.fn(async () => ({
      bytes: new Uint8Array([0x1f, 0x8b]),
      contentType: "application/vnd.quantized-mesh",
      contentEncoding: "gzip",
    }));
    const miss = await cachedTile(req(), ctx1, r2, p, gen1);
    expect(miss.headers.get("content-encoding")).toBe("gzip");
    await waitOnExecutionContext(ctx1);
    expect(r2Puts[0]!.contentEncoding).toBe("gzip");

    await clearCache(p);
    const ctx2 = createExecutionContext();
    const l2 = await cachedTile(req(), ctx2, r2, p, vi.fn(async () => tile()));
    expect(l2.headers.get("x-cache")).toBe("L2");
    expect(l2.headers.get("content-encoding")).toBe("gzip");
  });

  describe("freshness probe", () => {
    function r2KeyOf(p: TileCacheParams): string {
      return `cache/terrain/${p.tileset}/v${p.version}/${p.encoding}/${p.dataType}/${p.z}/${p.x}/${p.y}.${p.format}`;
    }
    const backdate = (key: string, uploaded: Date) =>
      (r2 as unknown as { _backdate: (key: string, uploaded: Date) => void })._backdate(key, uploaded);

    it("serves an L2 entry within the TTL window without calling the upstream probe", async () => {
      const p: TileCacheParams = {
        ...params, x: 100,
        freshness: { check: vi.fn(async () => new Date()), ttlMs: 60_000 },
      };
      const ctx1 = createExecutionContext();
      await cachedTile(req(), ctx1, r2, p, vi.fn(async () => tile(new Uint8Array([1, 1, 1]))));
      await waitOnExecutionContext(ctx1);
      await clearCache(p);

      const ctx2 = createExecutionContext();
      const gen = vi.fn(async () => tile());
      const resp = await cachedTile(req(), ctx2, r2, p, gen);
      expect(resp.headers.get("x-cache")).toBe("L2");
      expect(p.freshness!.check).not.toHaveBeenCalled();
      expect(gen).not.toHaveBeenCalled();
    });

    it("re-probes upstream once the L2 entry is older than the TTL", async () => {
      const p: TileCacheParams = {
        ...params, x: 101,
        freshness: { check: vi.fn(async () => new Date(1)), ttlMs: 60_000 },
      };
      // Seed L2 with a fresh upload, then back-date it past the TTL.
      const ctx1 = createExecutionContext();
      await cachedTile(req(), ctx1, r2, p, vi.fn(async () => tile(new Uint8Array([2, 2, 2]))));
      await waitOnExecutionContext(ctx1);
      backdate(r2KeyOf(p), new Date(Date.now() - 10 * 60_000));
      await clearCache(p);

      const ctx2 = createExecutionContext();
      const gen = vi.fn(async () => tile());
      const resp = await cachedTile(req(), ctx2, r2, p, gen);
      // Upstream Last-Modified is far in the past, so the entry is still trusted.
      expect(resp.headers.get("x-cache")).toBe("L2");
      expect(p.freshness!.check).toHaveBeenCalledOnce();
      expect(gen).not.toHaveBeenCalled();
    });

    it("regenerates when upstream Last-Modified is newer than the R2 uploaded time", async () => {
      const uploadedTime = Date.now() - 10 * 60_000;
      const p: TileCacheParams = {
        ...params, x: 102,
        freshness: {
          check: vi.fn(async () => new Date(uploadedTime + 60_000)),
          ttlMs: 60_000,
        },
      };
      const ctx1 = createExecutionContext();
      await cachedTile(req(), ctx1, r2, p, vi.fn(async () => tile(new Uint8Array([3, 3, 3]))));
      await waitOnExecutionContext(ctx1);
      backdate(r2KeyOf(p), new Date(uploadedTime));
      await clearCache(p);

      const ctx2 = createExecutionContext();
      const gen = vi.fn(async () => tile(new Uint8Array([4, 4, 4])));
      const resp = await cachedTile(req(), ctx2, r2, p, gen);
      expect(resp.headers.get("x-cache")).toBe("MISS");
      expect(gen).toHaveBeenCalledOnce();
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(new Uint8Array([4, 4, 4]));
    });

    it("trusts the cached entry when the probe returns null (upstream unknown)", async () => {
      const p: TileCacheParams = {
        ...params, x: 103,
        freshness: { check: vi.fn(async () => null), ttlMs: 60_000 },
      };
      const ctx1 = createExecutionContext();
      await cachedTile(req(), ctx1, r2, p, vi.fn(async () => tile(new Uint8Array([5, 5, 5]))));
      await waitOnExecutionContext(ctx1);
      backdate(r2KeyOf(p), new Date(Date.now() - 10 * 60_000));
      await clearCache(p);

      const ctx2 = createExecutionContext();
      const gen = vi.fn(async () => tile());
      const resp = await cachedTile(req(), ctx2, r2, p, gen);
      expect(resp.headers.get("x-cache")).toBe("L2");
      expect(gen).not.toHaveBeenCalled();
    });

    it("clients always see the long Cache-Control even though L1 stores a short one", async () => {
      const p: TileCacheParams = {
        ...params, x: 104,
        freshness: { check: vi.fn(async () => new Date(1)), ttlMs: 60_000 },
      };
      const ctx1 = createExecutionContext();
      const miss = await cachedTile(req(), ctx1, r2, p, vi.fn(async () => tile(new Uint8Array([6, 6, 6]))));
      expect(miss.headers.get("cache-control")).toMatch(/max-age=2592000/);
      await waitOnExecutionContext(ctx1);

      const ctx2 = createExecutionContext();
      const l1 = await cachedTile(req(), ctx2, r2, p, vi.fn(async () => tile()));
      expect(l1.headers.get("x-cache")).toBe("L1");
      expect(l1.headers.get("cache-control")).toMatch(/max-age=2592000/);
    });
  });
});

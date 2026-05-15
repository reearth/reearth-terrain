import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapterhornSource } from "./dem.js";
import { encode_terrarium, rgb_to_webp } from "./wasm/terrain-codec/terrain_codec.js";

// Build a 4x4 Terrarium-encoded WebP we can hand back from the stubbed fetch.
// `encode_terrarium` returns raw RGB; `rgb_to_webp` wraps it as a lossless WebP.
function fakeTile(elevs: number[], w = 4, h = 4): Uint8Array {
  const rgb = encode_terrarium(Float32Array.from(elevs), w, h);
  return rgb_to_webp(rgb, w, h);
}

function makeResponse(body: BodyInit, status = 200): Response {
  return new Response(body, { status });
}

describe("MapterhornSource.read", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null below minZoom and above maxZoom without fetching", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const src = new MapterhornSource({ minZoom: 2, maxZoom: 10 });
    expect(await src.read(1, 0, 0)).toBeNull();
    expect(await src.read(11, 0, 0)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a 404 response (no coverage)", async () => {
    const fetchMock = vi.fn(async () => makeResponse(new Uint8Array(), 404));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const src = new MapterhornSource();
    expect(await src.read(5, 1, 2)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws on a non-OK, non-404 status", async () => {
    globalThis.fetch = (async () =>
      makeResponse("oops", 500)) as unknown as typeof fetch;
    const src = new MapterhornSource();
    await expect(src.read(5, 0, 0)).rejects.toThrow(/-> 500/);
  });

  it("decodes a 200 response back to the input elevations", async () => {
    const elevs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
    const body = fakeTile(elevs);
    globalThis.fetch = (async () => makeResponse(body)) as unknown as typeof fetch;

    const src = new MapterhornSource();
    const tile = await src.read(5, 0, 0);
    expect(tile).not.toBeNull();
    expect(tile!.width).toBe(4);
    expect(tile!.height).toBe(4);
    // Terrarium is decimeter-quantised; expect exact match for clean integers.
    expect(Array.from(tile!.elevations)).toEqual(elevs);
  });

  it("hits the URL pattern {baseUrl}/{z}/{x}/{y}.webp", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return makeResponse(new Uint8Array(), 404);
    }) as unknown as typeof fetch;
    const src = new MapterhornSource({ baseUrl: "https://example.test" });
    await src.read(3, 4, 5);
    expect(seenUrl).toBe("https://example.test/3/4/5.webp");
  });

  it("serves the second hit from the in-memory cache without re-fetching", async () => {
    const body = fakeTile(Array.from({ length: 16 }, (_, i) => i * 10), 4, 4);
    const fetchMock = vi.fn(async () => makeResponse(body));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const src = new MapterhornSource();
    const a = await src.read(5, 0, 0);
    const b = await src.read(5, 0, 0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(b).toEqual(a);
  });

  it("caches the null result of a 404 (no second fetch)", async () => {
    const fetchMock = vi.fn(async () => makeResponse(new Uint8Array(), 404));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const src = new MapterhornSource();
    expect(await src.read(5, 9, 9)).toBeNull();
    expect(await src.read(5, 9, 9)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("single-flights concurrent requests for the same tile", async () => {
    const body = fakeTile(Array.from({ length: 16 }, (_, i) => i * 10), 4, 4);
    // Delay the response so both reads queue up in #inflight before either resolves.
    let resolveFetch!: () => void;
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((r) => {
        resolveFetch = r;
      });
      return makeResponse(body);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const src = new MapterhornSource();
    const p1 = src.read(7, 0, 0);
    const p2 = src.read(7, 0, 0);
    resolveFetch();
    const [a, b] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(a).toEqual(b);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MASK_SIZE, ProtomapsWaterMask, maskToRgba } from "./water.js";

// We don't ship a PMTiles fixture; instead, stub the underlying network so
// every range request fails. PMTiles' getZxy then throws, ProtomapsWaterMask
// catches per-tile, and the empty mask falls through to the uniform-land
// fast path — which is the only behavior we can reliably exercise without
// a real archive.
describe("ProtomapsWaterMask.buildMask", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the 1-byte uniform-land mask when every upstream tile is unreachable", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    const provider = new ProtomapsWaterMask("https://example.test/build.pmtiles");
    const mask = await provider.buildMask({ west: 0, east: 10, south: 0, north: 10 });
    // classifyMask returns [0] when nothing got marked water.
    expect(mask).toEqual(new Uint8Array([0]));
  });
});

describe("maskToRgba", () => {
  const pixels = MASK_SIZE * MASK_SIZE;

  it("expands uniform-land (1 byte = 0) to a fully transparent 256x256 RGBA buffer", () => {
    const rgba = maskToRgba(new Uint8Array([0]));
    expect(rgba.length).toBe(pixels * 4);
    for (let i = 0; i < rgba.length; i++) expect(rgba[i]).toBe(0);
  });

  it("expands uniform-water (1 byte = 255) to opaque-black pixels (R=G=B=0, A=255)", () => {
    const rgba = maskToRgba(new Uint8Array([255]));
    expect(rgba.length).toBe(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      expect(rgba[i * 4]).toBe(0);
      expect(rgba[i * 4 + 1]).toBe(0);
      expect(rgba[i * 4 + 2]).toBe(0);
      expect(rgba[i * 4 + 3]).toBe(255);
    }
  });

  it("maps a grid mask to alpha-only (RGB stays 0)", () => {
    const mask = new Uint8Array(pixels);
    // Water in the top-left 8x8 corner; land everywhere else.
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 8; i++) {
        mask[j * MASK_SIZE + i] = 255;
      }
    }
    const rgba = maskToRgba(mask);
    expect(rgba.length).toBe(pixels * 4);

    // Inside the water rect.
    const insideIdx = (3 * MASK_SIZE + 3) * 4;
    expect(rgba[insideIdx]).toBe(0);
    expect(rgba[insideIdx + 1]).toBe(0);
    expect(rgba[insideIdx + 2]).toBe(0);
    expect(rgba[insideIdx + 3]).toBe(255);

    // Outside the water rect — fully transparent.
    const outsideIdx = (100 * MASK_SIZE + 100) * 4;
    expect(rgba[outsideIdx]).toBe(0);
    expect(rgba[outsideIdx + 1]).toBe(0);
    expect(rgba[outsideIdx + 2]).toBe(0);
    expect(rgba[outsideIdx + 3]).toBe(0);
  });

  it("rejects payloads that are neither 1 byte nor 256*256", () => {
    expect(() => maskToRgba(new Uint8Array(42))).toThrow(/unexpected watermask length/);
  });
});

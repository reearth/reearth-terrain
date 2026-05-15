import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtomapsWaterMask } from "./water.js";

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

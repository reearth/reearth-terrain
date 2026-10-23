import { describe, expect, it, vi } from "vitest";
import { openCog, planReads } from "./cog.js";

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

describe("planReads", () => {
  it("joins ranges separated by less than the gap", () => {
    const groups = planReads(
      [
        { offset: 0, length: 100 },
        { offset: 110, length: 50 },
      ],
      16,
    );
    expect(groups).toEqual([{ offset: 0, end: 160, members: [0, 1] }]);
  });

  it("keeps ranges apart when the gap between them is too wide", () => {
    const groups = planReads(
      [
        { offset: 0, length: 100 },
        { offset: 200, length: 50 },
      ],
      16,
    );
    expect(groups.map((g) => [g.offset, g.end])).toEqual([
      [0, 100],
      [200, 250],
    ]);
  });

  it("groups by offset regardless of the order they arrive in", () => {
    const groups = planReads(
      [
        { offset: 300, length: 10 },
        { offset: 0, length: 10 },
        { offset: 305, length: 10 },
      ],
      16,
    );
    expect(groups).toEqual([
      { offset: 0, end: 10, members: [1] },
      { offset: 300, end: 315, members: [0, 2] },
    ]);
  });

  it("absorbs a range wholly contained in one already in the group", () => {
    // The group's end must not move backwards, or the contained range would
    // be sliced out of a buffer that stops before it.
    const groups = planReads(
      [
        { offset: 0, length: 100 },
        { offset: 10, length: 5 },
      ],
      16,
    );
    expect(groups).toEqual([{ offset: 0, end: 100, members: [0, 1] }]);
  });
});

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

/**
 * A little-endian tiled TIFF, one 16×16 uint8 tile per row of tiles, with the
 * tile index placed past the first kilobyte after the IFD — so geotiff.js
 * leaves `TileOffsets` and `TileByteCounts` out of the header read and loads
 * them on first use, as it does for the real geoid COG.
 */
function tiledTiff(tiles: number): Uint8Array {
  const side = 16;
  const offsetsAt = 2048;
  const countsAt = offsetsAt + 4 * tiles;
  const dataAt = countsAt + 4 * tiles;
  const buf = new ArrayBuffer(dataAt + tiles * side * side);
  const v = new DataView(buf);
  v.setUint16(0, 0x4949);
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true);

  const SHORT = 3;
  const LONG = 4;
  const entries: [tag: number, type: number, count: number, value: number][] = [
    [256, SHORT, 1, side], // ImageWidth
    [257, SHORT, 1, side * tiles], // ImageLength
    [258, SHORT, 1, 8], // BitsPerSample
    [259, SHORT, 1, 1], // Compression: none
    [262, SHORT, 1, 1], // PhotometricInterpretation: black is zero
    [277, SHORT, 1, 1], // SamplesPerPixel
    [284, SHORT, 1, 1], // PlanarConfiguration
    [322, SHORT, 1, side], // TileWidth
    [323, SHORT, 1, side], // TileLength
    [324, LONG, tiles, offsetsAt], // TileOffsets
    [325, LONG, tiles, countsAt], // TileByteCounts
    [339, SHORT, 1, 1], // SampleFormat: unsigned
  ];
  let p = 8;
  v.setUint16(p, entries.length, true);
  p += 2;
  for (const [tag, type, count, value] of entries) {
    v.setUint16(p, tag, true);
    v.setUint16(p + 2, type, true);
    v.setUint32(p + 4, count, true);
    if (type === SHORT && count === 1) v.setUint16(p + 8, value, true);
    else v.setUint32(p + 8, value, true);
    p += 12;
  }
  v.setUint32(p, 0, true); // no next IFD

  const bytes = new Uint8Array(buf);
  for (let i = 0; i < tiles; i++) {
    const at = dataAt + i * side * side;
    v.setUint32(offsetsAt + 4 * i, at, true);
    v.setUint32(countsAt + 4 * i, side * side, true);
    bytes.fill(i % 256, at, at + side * side);
  }
  return bytes;
}

/** An R2 bucket holding one object, with a hook to fail particular reads. */
function bucketOf(bytes: Uint8Array, fail: (offset: number) => boolean): R2Bucket {
  return fakeBucket(async (_key, opts?: R2GetOptions) => {
    const range = opts?.range as { offset: number; length: number };
    if (fail(range.offset)) throw new Error(`R2 read failed at ${range.offset}`);
    const slice = bytes.slice(range.offset, range.offset + range.length);
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => slice.buffer,
    } as unknown as R2ObjectBody;
  });
}

describe("openCog, reading the tile index", () => {
  const tiles = 300;
  const indexAt = 2048;
  const indexEnd = indexAt + 8 * tiles;

  it("retries a failed read of the tile index instead of remembering it", async () => {
    // geotiff.js keeps a failed first-use read forever. Left to it, one bad
    // R2 read of a tile's offset would fail that tile for the isolate's life
    // — and one that never settled would hang it.
    let failures = 1;
    const bucket = bucketOf(tiledTiff(tiles), (offset) =>
      offset >= indexAt && offset < indexEnd && failures-- > 0,
    );
    const key = `cog/index-retry-${crypto.randomUUID()}.tif`;

    await expect(openCog(bucket, key)).rejects.toThrow("R2 read failed");
    const { image } = await openCog(bucket, key);
    const [band] = (await image.readRasters({ window: [0, 32, 16, 48] })) as unknown as Uint8Array[];
    expect(band![0]).toBe(2);
  });

  it("reads nothing but tile data once the image is open", async () => {
    let opened = false;
    const bucket = bucketOf(tiledTiff(tiles), (offset) => opened && offset < indexEnd);
    const key = `cog/index-loaded-${crypto.randomUUID()}.tif`;

    const { image } = await openCog(bucket, key);
    opened = true;
    const [band] = (await image.readRasters({ window: [0, 160, 16, 176] })) as unknown as Uint8Array[];
    expect(band![0]).toBe(10);
  });
});

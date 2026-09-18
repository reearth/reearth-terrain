// The geoid path used to issue one R2 read per point, which made
// /heights.json the largest class B line on the account. These tests pin the
// two things that fix depends on: the values must not move, and the number of
// reads must stop tracking the number of points.

import { describe, expect, it, vi } from "vitest";
import { writeArrayBuffer } from "geotiff";

import { sampleGeoidAtPoints } from "./sample.js";

const WIDTH = 64;
const HEIGHT = 32;
const RES = 360 / WIDTH; // 5.625 degrees per pixel, square
const ORIGIN_X = -180;
const ORIGIN_Y = 90;

/**
 * A raster whose value is linear in the pixel coordinates: f(x, y) = 100x + y.
 * Bilinear interpolation of a linear function is exact, so every expected
 * value below is arithmetic rather than a recorded number.
 */
function linearRaster(): Float32Array {
  const values = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      values[y * WIDTH + x] = x * 100 + y;
    }
  }
  return values;
}

async function tiffBytes(): Promise<Uint8Array> {
  const buf = await writeArrayBuffer(linearRaster(), {
    width: WIDTH,
    height: HEIGHT,
    ModelPixelScale: [RES, RES, 0],
    ModelTiepoint: [0, 0, 0, ORIGIN_X, ORIGIN_Y, 0],
  });
  return new Uint8Array(buf as ArrayBuffer);
}

/** Pixel coordinates -> the lon/lat that lands on them. */
function atPixel(px: number, py: number) {
  return { lon: ORIGIN_X + px * RES, lat: ORIGIN_Y - py * RES };
}

/** An R2 bucket over one object that counts the range reads it serves. */
function countingBucket(bytes: Uint8Array) {
  const get = vi.fn(
    async (_key: string, opts?: { range?: { offset: number; length: number } }) => {
      const offset = opts?.range?.offset ?? 0;
      const length = opts?.range?.length ?? bytes.byteLength - offset;
      const end = Math.min(offset + length, bytes.byteLength);
      const slice = bytes.slice(offset, end);
      return {
        size: bytes.byteLength,
        arrayBuffer: async () => slice.buffer,
      };
    },
  );
  const bucket = { get, head: vi.fn(async () => ({ size: bytes.byteLength })) };
  return { bucket: bucket as unknown as R2Bucket, get };
}

// openCog memoizes by key for the life of the module, so each test uses its
// own key to get a cold source.
let keySeq = 0;
const freshKey = () => `cog/geoid-${keySeq++}.tif`;

describe("sampleGeoidAtPoints", () => {
  it("interpolates bilinearly between the surrounding pixels", async () => {
    const { bucket } = countingBucket(await tiffBytes());
    const out = await sampleGeoidAtPoints(bucket, freshKey(), [
      atPixel(10.3, 4.7),
      atPixel(2, 3), // exactly on a pixel
    ]);

    expect(out[0]).toBeCloseTo(10.3 * 100 + 4.7, 3);
    expect(out[1]).toBeCloseTo(2 * 100 + 3, 3);
  });

  it("reads a cluster of points without reading once per point", async () => {
    const { bucket, get } = countingBucket(await tiffBytes());
    const key = freshKey();

    // Two points, close together, to learn what one window costs.
    await sampleGeoidAtPoints(bucket, key, [atPixel(10.1, 4.1), atPixel(10.9, 4.9)]);
    const afterTwo = get.mock.calls.length;

    // Sixty more in the same neighbourhood must not cost sixty more reads.
    const many = Array.from({ length: 60 }, (_, i) =>
      atPixel(10 + (i % 8) * 0.1, 4 + Math.floor(i / 8) * 0.1),
    );
    await sampleGeoidAtPoints(bucket, key, many);

    expect(get.mock.calls.length).toBe(afterTwo);
  });

  it("buys a range once when neighbouring blocks race for it", async () => {
    // Blocks are read in parallel and adjacent blocks share the tiles on
    // their common edge, so the same byte range is asked for concurrently.
    const { bucket, get } = countingBucket(await tiffBytes());
    const key = freshKey();

    const onEdge = [
      atPixel(15.5, 4.5),
      atPixel(16.5, 4.5),
      atPixel(15.5, 5.5),
      atPixel(16.5, 5.5),
    ];
    await sampleGeoidAtPoints(bucket, key, onEdge);
    const first = get.mock.calls.length;

    // Nothing beyond the ranges those four already paid for.
    await sampleGeoidAtPoints(bucket, key, onEdge);
    expect(get.mock.calls.length).toBe(first);
  });

  it("normalizes longitudes outside the raster's domain", async () => {
    const { bucket } = countingBucket(await tiffBytes());
    const here = atPixel(10.3, 4.7);
    const out = await sampleGeoidAtPoints(bucket, freshKey(), [
      here,
      { lon: here.lon + 360, lat: here.lat },
      { lon: here.lon - 360, lat: here.lat },
    ]);

    expect(out[1]).toBeCloseTo(out[0]!, 6);
    expect(out[2]).toBeCloseTo(out[0]!, 6);
  });

  it("returns null for points outside the raster's latitude coverage", async () => {
    const { bucket } = countingBucket(await tiffBytes());
    const out = await sampleGeoidAtPoints(bucket, freshKey(), [
      { lon: 0, lat: 90 + RES }, // above the top edge
      { lon: 0, lat: ORIGIN_Y - HEIGHT * RES - RES }, // below the bottom edge
    ]);

    expect(out).toEqual([null, null]);
  });

  it("keeps scattered points in step with their own positions", async () => {
    // Points spread across the whole raster fall in different blocks; the
    // binning must not mix their windows up.
    const { bucket } = countingBucket(await tiffBytes());
    const pixels: [number, number][] = [
      [1.5, 1.5],
      [30.25, 20.75],
      [61.5, 29.5],
      [45, 10],
    ];
    const out = await sampleGeoidAtPoints(
      bucket,
      freshKey(),
      pixels.map(([px, py]) => atPixel(px, py)),
    );

    for (const [i, [px, py]] of pixels.entries()) {
      expect(out[i]).toBeCloseTo(px * 100 + py, 3);
    }
  });
});

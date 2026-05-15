import { describe, expect, it } from "vitest";
import {
  buildWaterMask,
  fullAvailability,
  geodeticTileBounds,
  MESH_GRID_SIZE,
} from "./cesium.js";

describe("MESH_GRID_SIZE", () => {
  it("matches the WASM-side constant", () => {
    expect(MESH_GRID_SIZE).toBe(65);
  });
});

describe("geodeticTileBounds", () => {
  it("z=0 root tiles cover the whole globe in two halves", () => {
    const west = geodeticTileBounds(0, 0, 0);
    const east = geodeticTileBounds(0, 1, 0);
    expect(west).toEqual({ west: -180, east: 0, south: -90, north: 90 });
    expect(east).toEqual({ west: 0, east: 180, south: -90, north: 90 });
  });

  it("y increases northward (TMS)", () => {
    const south = geodeticTileBounds(1, 0, 0);
    const north = geodeticTileBounds(1, 0, 1);
    expect(south.south).toBeLessThan(north.south);
    expect(south.north).toBe(north.south);
  });

  it("z=N has 2^(N+1) x 2^N tiles", () => {
    const z = 3;
    const lastX = (1 << (z + 1)) - 1;
    const lastY = (1 << z) - 1;
    const last = geodeticTileBounds(z, lastX, lastY);
    expect(last.east).toBeCloseTo(180, 9);
    expect(last.north).toBeCloseTo(90, 9);
  });
});

describe("fullAvailability", () => {
  it("emits an empty list under minZoom and a single rect at/above it", () => {
    const a = fullAvailability(2, 4);
    expect(a).toHaveLength(5);
    expect(a[0]).toEqual([]);
    expect(a[1]).toEqual([]);
    expect(a[2]).toEqual([{ startX: 0, startY: 0, endX: 7, endY: 3 }]);
    expect(a[3]).toEqual([{ startX: 0, startY: 0, endX: 15, endY: 7 }]);
    expect(a[4]).toEqual([{ startX: 0, startY: 0, endX: 31, endY: 15 }]);
  });

  it("includes z=0 when minZoom is 0", () => {
    const a = fullAvailability(0, 1);
    expect(a[0]).toEqual([{ startX: 0, startY: 0, endX: 1, endY: 0 }]);
  });
});

describe("buildWaterMask", () => {
  it("returns the 1-byte uniform-water mask when every sample is sea level", () => {
    const dem = new Float64Array(65 * 65); // all zeros, threshold=0 -> water
    const m = buildWaterMask(dem, 65);
    expect(m).toEqual(new Uint8Array([255]));
  });

  it("returns the 1-byte uniform-land mask when every sample is above threshold", () => {
    const dem = new Float64Array(65 * 65).fill(100);
    const m = buildWaterMask(dem, 65);
    expect(m).toEqual(new Uint8Array([0]));
  });

  it("returns a 256x256 grid mask for a mixed tile, with the right halves wet", () => {
    const size = 65;
    const dem = new Float64Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        // West half land (100m), east half water (-1m so <= threshold).
        dem[j * size + i] = i < size / 2 ? 100 : -1;
      }
    }
    const m = buildWaterMask(dem, size);
    expect(m.length).toBe(256 * 256);
    // West-edge pixel: land. East-edge pixel: water.
    expect(m[0]).toBe(0);
    expect(m[255]).toBe(255);
  });

  it("classifies NaN samples as land (Number.isFinite gate)", () => {
    const dem = new Float64Array(65 * 65).fill(Number.NaN);
    // First cell water so we don't degenerate to the uniform-land short-circuit.
    dem[0] = -10;
    const m = buildWaterMask(dem, 65);
    expect(m.length).toBe(256 * 256);
    expect(m[0]).toBe(255);
    expect(m[256 * 256 - 1]).toBe(0);
  });
});

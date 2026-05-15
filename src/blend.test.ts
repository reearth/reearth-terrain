import { describe, expect, it } from "vitest";
import { readTileSamples } from "./blend.js";
import type { DemSource, DemTile } from "./dem.js";
import type { Tileset } from "./tilesets.js";

// Minimal tileset for the elevation-only paths. `geoidKey` is unused when
// dataType === "elevation".
function makeTileset(dem: DemSource): Tileset {
  return {
    name: "test",
    version: "0",
    description: "",
    attribution: [],
    dem,
    geoidKey: "unused",
    minZoom: 0,
    maxZoom: 14,
  };
}

class FakeDem implements DemSource {
  readonly name = "fake";
  calls: { z: number; x: number; y: number }[] = [];
  constructor(private readonly fixture: (z: number, x: number, y: number) => DemTile | null) {}
  async read(z: number, x: number, y: number): Promise<DemTile | null> {
    this.calls.push({ z, x, y });
    return this.fixture(z, x, y);
  }
}

function flatTile(value: number, size = 512): DemTile {
  return { width: size, height: size, elevations: new Float32Array(size * size).fill(value) };
}

describe("readTileSamples (elevation path)", () => {
  it("returns the source elevations untouched when the tile size matches outSize", async () => {
    const dem = new FakeDem(() => flatTile(123, 16));
    const out = await readTileSamples(makeTileset(dem), "elevation", 5, 0, 0, { R2: {} as R2Bucket }, 16);
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
    expect(out.values[0]).toBe(123);
    expect(out.values[out.values.length - 1]).toBe(123);
  });

  it("resamples when the source tile differs from outSize", async () => {
    const dem = new FakeDem(() => flatTile(50, 8));
    const out = await readTileSamples(makeTileset(dem), "elevation", 5, 0, 0, { R2: {} as R2Bucket }, 16);
    expect(out.width).toBe(16);
    expect(out.values.length).toBe(16 * 16);
    // Bilinear resample of a constant tile is constant.
    expect(out.values[0]).toBeCloseTo(50, 6);
    expect(out.values[128]).toBeCloseTo(50, 6);
  });

  it("walks up to an ancestor when the requested tile is missing", async () => {
    // Only z=3 has data; z=5 (requested) and z=4 do not.
    const dem = new FakeDem((z) => (z === 3 ? flatTile(77, 16) : null));
    const out = await readTileSamples(makeTileset(dem), "elevation", 5, 1, 1, { R2: {} as R2Bucket }, 16);
    // Tile content (constant 77) survives crop + resample.
    expect(out.values[0]).toBeCloseTo(77, 6);
    // Walked all three zooms — 5, 4, 3.
    expect(dem.calls.map((c) => c.z)).toEqual([5, 4, 3]);
    // Ancestor coordinates halve each step.
    expect(dem.calls[1]).toEqual({ z: 4, x: 0, y: 0 });
    expect(dem.calls[2]).toEqual({ z: 3, x: 0, y: 0 });
  });

  it("returns a zero grid when no ancestor has coverage", async () => {
    const dem = new FakeDem(() => null);
    const out = await readTileSamples(makeTileset(dem), "elevation", 5, 0, 0, { R2: {} as R2Bucket }, 8);
    expect(out.width).toBe(8);
    expect(out.values.length).toBe(64);
    expect(out.values.every((v) => v === 0)).toBe(true);
    // Walked all the way down to z=0.
    expect(dem.calls).toHaveLength(6);
  });
});

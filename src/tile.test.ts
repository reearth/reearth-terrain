import { describe, expect, it } from "vitest";
import type { GeoTIFFImage } from "geotiff";
import {
  lonLatBoundsToPixelWindow,
  tileToLonLatBounds,
} from "./tile.js";

describe("tileToLonLatBounds", () => {
  it("covers the whole globe at z=0", () => {
    const b = tileToLonLatBounds(0, 0, 0);
    expect(b.west).toBe(-180);
    expect(b.east).toBe(180);
    // Web Mercator caps lat near ±85.0511.
    expect(b.north).toBeCloseTo(85.0511287798066, 6);
    expect(b.south).toBeCloseTo(-85.0511287798066, 6);
  });

  it("splits the globe in half at z=1", () => {
    const nw = tileToLonLatBounds(1, 0, 0);
    const ne = tileToLonLatBounds(1, 1, 0);
    const sw = tileToLonLatBounds(1, 0, 1);

    expect(nw.west).toBe(-180);
    expect(nw.east).toBe(0);
    expect(ne.west).toBe(0);
    expect(ne.east).toBe(180);
    // Northern row meets at the equator.
    expect(nw.south).toBeCloseTo(0, 9);
    expect(sw.north).toBeCloseTo(0, 9);
  });

  it("is symmetric about the equator", () => {
    const top = tileToLonLatBounds(3, 4, 0);
    const bot = tileToLonLatBounds(3, 4, 7);
    expect(top.north).toBeCloseTo(-bot.south, 9);
    expect(top.south).toBeCloseTo(-bot.north, 9);
  });
});

// Build a fake GeoTIFFImage covering -180..180 / 90..-90 at 1 deg/px
// (360x180 image, north-up so resY is negative).
function fakeImage(opts?: {
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
  resX?: number;
  resY?: number;
}): GeoTIFFImage {
  const width = opts?.width ?? 360;
  const height = opts?.height ?? 180;
  const originX = opts?.originX ?? -180;
  const originY = opts?.originY ?? 90;
  const resX = opts?.resX ?? 1;
  const resY = opts?.resY ?? -1;
  return {
    getOrigin: () => [originX, originY, 0],
    getResolution: () => [resX, resY, 0],
    getWidth: () => width,
    getHeight: () => height,
  } as unknown as GeoTIFFImage;
}

describe("lonLatBoundsToPixelWindow", () => {
  it("maps the globe-wide bbox to the full image window", () => {
    const img = fakeImage();
    const w = lonLatBoundsToPixelWindow(img, {
      west: -180,
      east: 180,
      north: 90,
      south: -90,
    });
    // Adding 0 normalizes -0 -> 0; floor on the upper-left corner produces -0.
    expect(w.left + 0).toBe(0);
    expect(w.top + 0).toBe(0);
    expect(w.right).toBe(360);
    expect(w.bottom).toBe(180);
  });

  it("rounds outward so partial pixels are included", () => {
    const img = fakeImage();
    const w = lonLatBoundsToPixelWindow(img, {
      west: -179.4,
      east: -178.2,
      north: 89.6,
      south: 88.1,
    });
    // west=-179.4 -> xMin=0.6 floor=0; east=-178.2 -> xMax=1.8 ceil=2
    // north=89.6 -> yA=0.4 floor=0; south=88.1 -> yB=1.9 ceil=2
    expect(w).toEqual({ left: 0, top: 0, right: 2, bottom: 2 });
  });

  it("clamps a bbox extending past the image extent", () => {
    const img = fakeImage();
    const w = lonLatBoundsToPixelWindow(img, {
      west: -200,
      east: 200,
      north: 100,
      south: -100,
    });
    expect(w).toEqual({ left: 0, top: 0, right: 360, bottom: 180 });
  });

  it("collapses to a zero-area window for an out-of-image bbox", () => {
    // Image covers only the eastern hemisphere.
    const img = fakeImage({ width: 180, originX: 0 });
    const w = lonLatBoundsToPixelWindow(img, {
      west: -50,
      east: -10,
      north: 10,
      south: -10,
    });
    expect(w.right - w.left).toBe(0);
  });
});

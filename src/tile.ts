// XYZ tile math and helpers for mapping a {z,x,y} tile to a geographic
// bounding box and to a pixel window inside a geo-referenced image.

import type { GeoTIFFImage } from "geotiff";

export interface LonLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface PixelWindow {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const RAD2DEG = 180 / Math.PI;

/** Convert a Web Mercator XYZ tile to a longitude/latitude bounding box (WGS84). */
export function tileToLonLatBounds(z: number, x: number, y: number): LonLatBounds {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * RAD2DEG;
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * RAD2DEG;
  return { west, south, east, north };
}

/**
 * Convert a geographic bounding box (in the image's CRS) to a pixel-space
 * window suitable for `image.readRasters({ window })`. The window is clamped
 * to the image extent and may collapse to a zero-area rect when the bbox is
 * outside the image — callers should check.
 */
export function lonLatBoundsToPixelWindow(
  image: GeoTIFFImage,
  bounds: LonLatBounds,
): PixelWindow {
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const originX = origin[0]!;
  const originY = origin[1]!;
  const resX = resolution[0]!;
  const resY = resolution[1]!;
  const width = image.getWidth();
  const height = image.getHeight();

  // resY is typically negative for a north-up image (origin is top-left,
  // pixels grow southward). Handle both orientations.
  const xMin = (bounds.west - originX) / resX;
  const xMax = (bounds.east - originX) / resX;
  const yA = (bounds.north - originY) / resY;
  const yB = (bounds.south - originY) / resY;

  let left = Math.floor(Math.min(xMin, xMax));
  let right = Math.ceil(Math.max(xMin, xMax));
  let top = Math.floor(Math.min(yA, yB));
  let bottom = Math.ceil(Math.max(yA, yB));

  left = clamp(left, 0, width);
  right = clamp(right, 0, width);
  top = clamp(top, 0, height);
  bottom = clamp(bottom, 0, height);

  return { left, top, right, bottom };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface ReadTileResult {
  /** Single-band elevation values, row-major, length = outWidth * outHeight. */
  data: Float32Array;
  outWidth: number;
  outHeight: number;
  /** Pixel window actually read from the source image. */
  window: PixelWindow;
  /** True if the requested tile bounds fell outside the image extent. */
  outOfBounds: boolean;
}

/**
 * Resample a 256x256 (or custom-size) elevation patch from `image` for the
 * given XYZ tile. The image is assumed to be in EPSG:4326. Reprojection from
 * Web Mercator is approximate at low zoom but converges at the equator and
 * is acceptable for an MVP. Proper Mercator-aware sampling can be layered in
 * later.
 */
export async function readTileFromImage(
  image: GeoTIFFImage,
  z: number,
  x: number,
  y: number,
  outSize = 256,
): Promise<ReadTileResult> {
  const bounds = tileToLonLatBounds(z, x, y);
  const window = lonLatBoundsToPixelWindow(image, bounds);

  const empty = window.right <= window.left || window.bottom <= window.top;
  if (empty) {
    return {
      data: new Float32Array(outSize * outSize),
      outWidth: outSize,
      outHeight: outSize,
      window,
      outOfBounds: true,
    };
  }

  const rasters = await image.readRasters({
    window: [window.left, window.top, window.right, window.bottom],
    width: outSize,
    height: outSize,
    interleave: false,
    samples: [0],
  });

  // With `samples: [0]` and `interleave: false`, geotiff returns
  // `TypedArray[]` with one entry. Normalize to a Float32Array.
  const band = Array.isArray(rasters) ? rasters[0] : rasters;
  if (!band) throw new Error("readRasters returned no band");

  const data =
    band instanceof Float32Array
      ? band
      : Float32Array.from(band as ArrayLike<number>);

  return { data, outWidth: outSize, outHeight: outSize, window, outOfBounds: false };
}

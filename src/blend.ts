// Combines DEM (orthometric height) and geoid undulation samples into an
// ellipsoid-height grid for a given XYZ tile. Both inputs are resampled
// onto the same Web Mercator tile bbox at the same pixel size so they can
// be added element-wise.

import type { DemSource } from "./dem.js";
import { openCog } from "./cog.js";
import { readTileFromImage } from "./tile.js";
import type { Tileset } from "./tilesets.js";

export type DataType = "geoid" | "elevation" | "ellipsoid";

export interface TileSamples {
  width: number;
  height: number;
  values: Float32Array;
}

/**
 * Read a 512x512 (or `outSize`) elevation grid for the requested data type
 * from the given tileset.
 *
 * - `elevation`: orthometric height (meters above geoid) from the DEM source
 * - `geoid`: geoid undulation (meters) from the tileset's geoid COG
 * - `ellipsoid`: elevation + geoid, i.e. height above the WGS84 ellipsoid
 */
export async function readTileSamples(
  tileset: Tileset,
  dataType: DataType,
  z: number,
  x: number,
  y: number,
  env: { R2: R2Bucket },
  outSize = 512,
): Promise<TileSamples> {
  if (dataType === "elevation") {
    return await readDem(tileset.dem, z, x, y, outSize);
  }
  if (dataType === "geoid") {
    return await readGeoid(env.R2, tileset.geoidKey, z, x, y, outSize);
  }

  // ellipsoid = elevation + geoid
  const [elev, geoid] = await Promise.all([
    readDem(tileset.dem, z, x, y, outSize),
    readGeoid(env.R2, tileset.geoidKey, z, x, y, outSize),
  ]);
  if (elev.values.length !== geoid.values.length) {
    throw new Error(`grid size mismatch: dem=${elev.values.length} geoid=${geoid.values.length}`);
  }
  const out = new Float32Array(elev.values.length);
  for (let i = 0; i < elev.values.length; i++) {
    out[i] = elev.values[i]! + geoid.values[i]!;
  }
  return { width: elev.width, height: elev.height, values: out };
}

async function readDem(
  dem: DemSource,
  z: number,
  x: number,
  y: number,
  outSize: number,
): Promise<TileSamples> {
  // Mapterhorn's coverage is uneven — Andes/Himalaya/Antarctica/etc. have no
  // z>=13 tiles. If the requested tile is missing, walk up to ancestors and
  // crop. Without this fallback we'd serve flat-zero terrain (the geoid grid
  // alone), which produces a ~3 km cliff against the neighbouring tile that
  // does have z=14 data — the visible "crack" around Lake Titicaca, etc.
  for (let cz = z, cx = x, cy = y; cz >= 0; cz--, cx >>= 1, cy >>= 1) {
    const tile = await dem.read(cz, cx, cy);
    if (!tile) continue;
    if (cz === z) {
      if (tile.width === outSize && tile.height === outSize) {
        return { width: tile.width, height: tile.height, values: tile.elevations };
      }
      return resampleBilinear(tile.elevations, tile.width, tile.height, outSize, outSize);
    }
    // Crop the (z-cz)-level descendant region within the ancestor tile.
    const factor = 1 << (z - cz);
    const subX = x - (cx << (z - cz));
    const subY = y - (cy << (z - cz));
    return cropAndResample(
      tile.elevations,
      tile.width,
      tile.height,
      subX / factor,
      subY / factor,
      1 / factor,
      outSize,
    );
  }
  // Nothing anywhere — caller wants `elevation` data only (no geoid blend);
  // a zero grid is the only honest answer.
  return { width: outSize, height: outSize, values: new Float32Array(outSize * outSize) };
}

/** Crop a normalised sub-rectangle `(u0, v0, size, size)` of `src` and
 *  resample it to `dw × dw`. Used to upsample a parent DEM tile when the
 *  requested high-zoom tile is missing. */
function cropAndResample(
  src: Float32Array,
  sw: number,
  sh: number,
  u0: number,
  v0: number,
  size: number,
  dw: number,
): TileSamples {
  const out = new Float32Array(dw * dw);
  for (let j = 0; j < dw; j++) {
    const fy = (v0 + (j / (dw - 1)) * size) * (sh - 1);
    const y0 = Math.min(sh - 1, Math.max(0, Math.floor(fy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let i = 0; i < dw; i++) {
      const fx = (u0 + (i / (dw - 1)) * size) * (sw - 1);
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(fx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const a = src[y0 * sw + x0]!;
      const b = src[y0 * sw + x1]!;
      const c = src[y1 * sw + x0]!;
      const d = src[y1 * sw + x1]!;
      const ab = a + (b - a) * wx;
      const cd = c + (d - c) * wx;
      out[j * dw + i] = ab + (cd - ab) * wy;
    }
  }
  return { width: dw, height: dw, values: out };
}

async function readGeoid(
  bucket: R2Bucket,
  key: string,
  z: number,
  x: number,
  y: number,
  outSize: number,
): Promise<TileSamples> {
  const { image } = await openCog(bucket, key);
  const result = await readTileFromImage(image, z, x, y, outSize);
  return { width: result.outWidth, height: result.outHeight, values: result.data };
}

/** Plain bilinear resampler. */
function resampleBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): TileSamples {
  const out = new Float32Array(dw * dh);
  const sx = (sw - 1) / (dw - 1 || 1);
  const sy = (sh - 1) / (dh - 1 || 1);
  for (let j = 0; j < dh; j++) {
    const fy = j * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = fy - y0;
    for (let i = 0; i < dw; i++) {
      const fx = i * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = fx - x0;
      const a = src[y0 * sw + x0]!;
      const b = src[y0 * sw + x1]!;
      const c = src[y1 * sw + x0]!;
      const d = src[y1 * sw + x1]!;
      const ab = a + (b - a) * wx;
      const cd = c + (d - c) * wx;
      out[j * dw + i] = ab + (cd - ab) * wy;
    }
  }
  return { width: dw, height: dh, values: out };
}

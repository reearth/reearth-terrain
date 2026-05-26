// Point-sampling API: take a list of lon/lat points and return the
// orthometric DEM height, geoid undulation, and ellipsoidal height at
// each. Sister to `sampleGrid` (which samples a regular grid for tile
// generation), but optimized for arbitrary sparse points:
//
//   - DEM samples are grouped by their containing Web Mercator tile at
//     `tileset.maxZoom`, so each unique tile is fetched once. Tiles that
//     are missing at the requested zoom retry one zoom coarser, mirroring
//     the cascade in `sampleGrid`.
//   - Geoid samples come from a single shared COG that's already memoized
//     in `openCog`. The grid is small (2.5-arcminute global), so per-point
//     bilinear interpolation hits geotiff.js's tile cache after the first
//     few reads.
//
// Out-of-coverage points get `null` per field. Geoid coverage is global,
// so `geoid` is essentially always populated; `elevation` and `ellipsoid`
// fall to null when the DEM has no tiles at any zoom for the point.

import type { DemSource, DemTile } from "./dem.js";
import { openCog } from "./cog.js";
import type { Tileset } from "./tilesets.js";

export interface SamplePoint {
  lon: number;
  lat: number;
}

export interface PointHeights {
  elevation: number | null;
  geoid: number | null;
  ellipsoid: number | null;
}

/** Web Mercator latitude range (the projection becomes undefined past this). */
const WM_LAT_MAX = 85.0511287798066;

export async function samplePointHeights(
  tileset: Tileset,
  points: SamplePoint[],
  env: { R2: R2Bucket },
): Promise<PointHeights[]> {
  const [dem, geoid] = await Promise.all([
    sampleDemAtPoints(tileset.dem, points, tileset.maxZoom),
    sampleGeoidAtPoints(env.R2, tileset.geoidKey, points),
  ]);

  const out: PointHeights[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const e = dem[i];
    const g = geoid[i];
    out[i] = {
      elevation: e ?? null,
      geoid: g ?? null,
      ellipsoid: e != null && g != null ? e + g : null,
    };
  }
  return out;
}

/**
 * Bin points into the WM tile that contains them at `maxZoom`. For each
 * unique tile, try to fetch it; if missing, cascade one zoom coarser for
 * just that tile-group. Points that never resolve return null.
 *
 * The cascade is per-tile (not global) so a single missing edge tile
 * doesn't drag accuracy down across the rest of the request.
 */
async function sampleDemAtPoints(
  dem: DemSource,
  points: SamplePoint[],
  maxZoom: number,
): Promise<(number | null)[]> {
  const out: (number | null)[] = new Array(points.length).fill(null);

  // Bin points by tile at maxZoom.
  type Bin = { tx: number; ty: number; indices: number[] };
  const bins = new Map<string, Bin>();
  for (let i = 0; i < points.length; i++) {
    const { lon, lat } = points[i]!;
    const { tx, ty } = lonLatToTile(lon, lat, maxZoom);
    const key = `${tx}/${ty}`;
    let bin = bins.get(key);
    if (!bin) {
      bin = { tx, ty, indices: [] };
      bins.set(key, bin);
    }
    bin.indices.push(i);
  }

  await Promise.all(
    Array.from(bins.values()).map(async (bin) => {
      const result = await fetchTileWithCascade(dem, maxZoom, bin.tx, bin.ty);
      if (!result) return;
      const { tile, z } = result;
      for (const idx of bin.indices) {
        const { lon, lat } = points[idx]!;
        out[idx] = bilinearSampleWmTile(tile, z, lon, lat);
      }
    }),
  );
  return out;
}

/**
 * Walk zoom levels from `zStart` down to 0 until a tile fetch succeeds.
 * `xStart`/`yStart` are the coords at `zStart`; we shift right by `dz` per
 * step to find the parent tile.
 */
async function fetchTileWithCascade(
  dem: DemSource,
  zStart: number,
  xStart: number,
  yStart: number,
): Promise<{ tile: DemTile; z: number } | null> {
  for (let z = zStart; z >= 0; z--) {
    const shift = zStart - z;
    const x = xStart >> shift;
    const y = yStart >> shift;
    const tile = await dem.read(z, x, y);
    if (tile) return { tile, z };
  }
  return null;
}

/** Bilinear-sample a WM DEM tile at (lon, lat). Assumes the point falls inside. */
function bilinearSampleWmTile(tile: DemTile, z: number, lon: number, lat: number): number {
  const n = 1 << z;
  const xf = ((lon + 180) / 360) * n;
  const latClamped = Math.max(-WM_LAT_MAX, Math.min(WM_LAT_MAX, lat));
  const rad = (latClamped * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const fx = (xf - Math.floor(xf)) * tile.width;
  const fy = (yf - Math.floor(yf)) * tile.height;
  return bilinear(tile.elevations, tile.width, tile.height, fx, fy);
}

function lonLatToTile(lon: number, lat: number, z: number): { tx: number; ty: number } {
  const n = 1 << z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latClamped = Math.max(-WM_LAT_MAX, Math.min(WM_LAT_MAX, lat));
  const rad = (latClamped * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return {
    tx: ((x % n) + n) % n,
    ty: Math.max(0, Math.min(n - 1, y)),
  };
}

function bilinear(
  data: ArrayLike<number>,
  w: number,
  h: number,
  fx: number,
  fy: number,
): number {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const dx = fx - x0;
  const dy = fy - y0;
  const v00 = data[y0 * w + x0]!;
  const v10 = data[y0 * w + x1]!;
  const v01 = data[y1 * w + x0]!;
  const v11 = data[y1 * w + x1]!;
  return (v00 * (1 - dx) + v10 * dx) * (1 - dy) + (v01 * (1 - dx) + v11 * dx) * dy;
}

/**
 * Sample the EGM2008 COG at each point. The COG is small (2.5-arcminute
 * global) and `openCog` is memoized, so geotiff.js's strip cache covers
 * subsequent calls cheaply. Returns null only when the COG read errors.
 */
async function sampleGeoidAtPoints(
  bucket: R2Bucket,
  key: string,
  points: SamplePoint[],
): Promise<(number | null)[]> {
  const out: (number | null)[] = new Array(points.length).fill(null);
  if (points.length === 0) return out;

  const { image } = await openCog(bucket, key);
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const originX = origin[0]!;
  const originY = origin[1]!;
  const resX = resolution[0]!;
  const resY = resolution[1]!;
  const width = image.getWidth();
  const height = image.getHeight();

  // EGM2008 wraps in longitude. We normalize lon into the COG's domain
  // so a point at lon=180 + epsilon still samples the correct strip.
  const lonSpan = width * resX; // typically 360
  await Promise.all(
    points.map(async (p, i) => {
      let lon = p.lon;
      // Normalize into [originX, originX + lonSpan).
      const rel = ((lon - originX) % lonSpan + lonSpan) % lonSpan;
      lon = originX + rel;
      const px = (lon - originX) / resX;
      const py = (p.lat - originY) / resY;
      if (py < 0 || py > height || px < 0 || px > width) return;
      try {
        out[i] = await bilinearReadAt(image, px, py, width, height);
      } catch {
        out[i] = null;
      }
    }),
  );
  return out;
}

async function bilinearReadAt(
  image: import("geotiff").GeoTIFFImage,
  px: number,
  py: number,
  width: number,
  height: number,
): Promise<number> {
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(px)));
  const y0 = Math.max(0, Math.min(height - 2, Math.floor(py)));
  const rasters = await image.readRasters({
    window: [x0, y0, x0 + 2, y0 + 2],
    width: 2,
    height: 2,
    interleave: false,
    samples: [0],
  });
  const band = Array.isArray(rasters) ? rasters[0] : rasters;
  const arr = band as ArrayLike<number>;
  const dx = px - x0;
  const dy = py - y0;
  const v00 = arr[0]!;
  const v10 = arr[1]!;
  const v01 = arr[2]!;
  const v11 = arr[3]!;
  return (v00 * (1 - dx) + v10 * dx) * (1 - dy) + (v01 * (1 - dx) + v11 * dx) * dy;
}

/**
 * Parse the `points=lon,lat;lon,lat;...` query value. Whitespace and
 * stray empty entries are tolerated. Throws on malformed numbers or
 * out-of-range latitudes; longitude is unconstrained because callers may
 * pass values outside [-180,180] (we normalize on sampling).
 */
export function parsePointsParam(raw: string): SamplePoint[] {
  const out: SamplePoint[] = [];
  for (const seg of raw.split(";")) {
    const s = seg.trim();
    if (!s) continue;
    const parts = s.split(",");
    if (parts.length !== 2) {
      throw new Error(`malformed point: "${s}" (expected "lon,lat")`);
    }
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new Error(`malformed point: "${s}" (non-numeric component)`);
    }
    if (lat < -90 || lat > 90) {
      throw new Error(`latitude out of range: ${lat} (expected -90..90)`);
    }
    out.push({ lon, lat });
  }
  return out;
}

/** Maximum number of points accepted per request. */
export const MAX_POINTS_PER_REQUEST = 256;

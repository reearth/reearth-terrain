// Cesium quantized-mesh-1.0 support.
//
// Cesium uses a "Geographic" (TMS) tiling scheme — not Web Mercator XYZ:
//   - z=0: 2x1 root tiles covering the whole globe in lon/lat
//   - z=N: 2^(N+1) x 2^N tiles
//   - Y is bottom-up (TMS), unlike XYZ
//
// To serve quantized-mesh, we sample our DEM (Mapterhorn, Web Mercator)
// and geoid (EGM08 COG, WGS84) over the geodetic tile bbox at a 65x65
// grid and hand the result to the WASM encoder.

import type { DemSource, DemTile } from "./dem.js";
import { openCog } from "./cog.js";
import { lonLatBoundsToPixelWindow, type LonLatBounds } from "./tile.js";
import type { Tileset } from "./tilesets.js";

/** Grid size handed to the WASM mesh encoder. Must match MESH_GRID_SIZE in Rust (65). */
export const MESH_GRID_SIZE = 65;

export interface GeodeticBounds extends LonLatBounds {}

/**
 * Bounds of a Cesium Geographic (TMS) tile.
 * Y is bottom-up: y=0 is the southernmost row.
 */
export function geodeticTileBounds(z: number, x: number, y: number): GeodeticBounds {
  const lonStep = 360 / (1 << (z + 1));
  const latStep = 180 / (1 << z);
  const west = -180 + x * lonStep;
  const south = -90 + y * latStep;
  return {
    west,
    east: west + lonStep,
    south,
    north: south + latStep,
  };
}

/** Returns the per-zoom-level "available" tile rectangles for a fully-populated tileset. */
export function fullAvailability(minZoom: number, maxZoom: number) {
  const out: { startX: number; startY: number; endX: number; endY: number }[][] = [];
  for (let z = 0; z <= maxZoom; z++) {
    if (z < minZoom) {
      out.push([]);
      continue;
    }
    out.push([
      {
        startX: 0,
        startY: 0,
        endX: (1 << (z + 1)) - 1,
        endY: (1 << z) - 1,
      },
    ]);
  }
  return out;
}

/**
 * Sample the tileset's elevation grid for the given lon/lat bounds.
 *
 * Output layout: row-major, north-to-south, west-to-east, length = size*size.
 * Values are in meters above the WGS84 ellipsoid (orthometric + geoid).
 *
 * `dataType` mirrors the raster endpoint contract:
 *   "elevation" -> DEM only (orthometric)
 *   "geoid"     -> geoid undulation only
 *   "ellipsoid" -> DEM + geoid
 */
export type SampleDataType = "geoid" | "elevation" | "ellipsoid";

export interface SampledGrid {
  /** Final values for the requested data type (input to the mesh encoder). */
  elevations: Float64Array;
  /**
   * Orthometric DEM samples on the same grid, if the DEM source contributed
   * to this read. Useful for downstream water-mask classification against a
   * fixed `0 m` sea-level threshold without needing to know the geoid offset.
   */
  dem: Float64Array | null;
  /**
   * Halo-extended elevation grid, sampled over bounds expanded by
   * `haloCells` grid-cells on every side, at size `(size + 2*haloCells)²`.
   * Present only when `opts.haloCells > 0`. Used by mesh generation to
   * compute DEM-gradient normals that stay continuous across tile edges.
   */
  elevationsWithHalo?: Float64Array;
  /** Number of halo cells extending past the tile on each side. */
  haloCells?: number;
}

export interface SampleGridOptions {
  /**
   * Extend the sampled grid by this many cells on every side. The returned
   * `elevationsWithHalo` is `(size + 2*haloCells)²` and covers bounds
   * expanded so the per-cell step matches the inner grid. Used by
   * gradient-based normal computation: adjacent tiles sample the same
   * physical positions in their halos, so the seam normals match.
   */
  haloCells?: number;
}

export async function sampleGrid(
  tileset: Tileset,
  bounds: GeodeticBounds,
  size: number,
  dataType: SampleDataType,
  env: { R2: R2Bucket },
  opts: SampleGridOptions = {},
): Promise<SampledGrid> {
  const haloCells = opts.haloCells ?? 0;

  const haloSize = size + 2 * haloCells;
  const haloBounds = haloCells > 0 ? expandBounds(bounds, size, haloCells) : bounds;

  // Pin the WM zoom to the inner bounds so the halo path never picks a
  // different DEM zoom than the no-halo path — keeps cached tiles
  // byte-stable across the feature flip.
  const [demGrid, demGridHalo, geoidGrid, geoidGridHalo] = await Promise.all([
    dataType === "geoid" ? null : sampleDem(tileset.dem, bounds, size, tileset.maxZoom),
    dataType === "geoid" || haloCells === 0
      ? null
      : sampleDem(tileset.dem, haloBounds, haloSize, tileset.maxZoom, bounds),
    dataType === "elevation" ? null : sampleGeoid(env.R2, tileset.geoidKey, bounds, size),
    dataType === "elevation" || haloCells === 0
      ? null
      : sampleGeoid(env.R2, tileset.geoidKey, haloBounds, haloSize),
  ]);

  const elevations = new Float64Array(size * size);
  if (demGrid && geoidGrid) {
    for (let i = 0; i < elevations.length; i++) elevations[i] = demGrid[i]! + geoidGrid[i]!;
  } else if (demGrid) {
    for (let i = 0; i < elevations.length; i++) elevations[i] = demGrid[i]!;
  } else if (geoidGrid) {
    for (let i = 0; i < elevations.length; i++) elevations[i] = geoidGrid[i]!;
  }

  let elevationsWithHalo: Float64Array | undefined;
  if (haloCells > 0) {
    elevationsWithHalo = new Float64Array(haloSize * haloSize);
    if (demGridHalo && geoidGridHalo) {
      for (let i = 0; i < elevationsWithHalo.length; i++)
        elevationsWithHalo[i] = demGridHalo[i]! + geoidGridHalo[i]!;
    } else if (demGridHalo) {
      for (let i = 0; i < elevationsWithHalo.length; i++) elevationsWithHalo[i] = demGridHalo[i]!;
    } else if (geoidGridHalo) {
      for (let i = 0; i < elevationsWithHalo.length; i++) elevationsWithHalo[i] = geoidGridHalo[i]!;
    }
  }

  return {
    elevations,
    dem: demGrid,
    ...(elevationsWithHalo ? { elevationsWithHalo, haloCells } : {}),
  };
}

function expandBounds(
  bounds: GeodeticBounds,
  size: number,
  haloCells: number,
): GeodeticBounds {
  // The inner grid spans `bounds` with (size - 1) cells per side. We want
  // the halo grid to share that per-cell step, so we extend by exactly
  // `haloCells` cells on every side.
  const cellLon = (bounds.east - bounds.west) / (size - 1);
  const cellLat = (bounds.north - bounds.south) / (size - 1);
  return {
    west: bounds.west - cellLon * haloCells,
    east: bounds.east + cellLon * haloCells,
    south: bounds.south - cellLat * haloCells,
    north: bounds.north + cellLat * haloCells,
  };
}

/**
 * Build a Cesium water mask byte array (1 byte Uniform OR 65536 byte Grid)
 * from an orthometric DEM grid. `sourceSize` is the side length of `dem`
 * (typically 65). Pixels at or below `threshold` (meters above geoid) are
 * water (255), the rest are land (0).
 */
export function buildWaterMask(
  dem: Float64Array,
  sourceSize: number,
  threshold = 0,
): Uint8Array {
  const buf = new Uint8Array(256 * 256);
  const scale = sourceSize / 256;
  let anyWater = false;
  let anyLand = false;
  for (let j = 0; j < 256; j++) {
    const sy = Math.min(sourceSize - 1, Math.floor((j + 0.5) * scale));
    for (let i = 0; i < 256; i++) {
      const sx = Math.min(sourceSize - 1, Math.floor((i + 0.5) * scale));
      const h = dem[sy * sourceSize + sx]!;
      if (Number.isFinite(h) && h <= threshold) {
        buf[j * 256 + i] = 255;
        anyWater = true;
      } else {
        anyLand = true;
      }
    }
  }
  if (!anyWater) return new Uint8Array([0]);
  if (!anyLand) return new Uint8Array([255]);
  return buf;
}

/**
 * Sample the DEM (Mapterhorn / Web Mercator) at `size`*`size` grid points
 * covering `bounds`. We fetch the minimum set of WM tiles that contain
 * those points and bilinearly interpolate.
 */
async function sampleDem(
  dem: DemSource,
  bounds: GeodeticBounds,
  size: number,
  demMaxZoom: number,
  // When sampling a halo-extended bounds, callers pass the inner (tile)
  // bounds here so the WM zoom is picked the same way the no-halo path
  // would pick it — otherwise the slightly wider halo lonSpan can round
  // to a different zoom at borderline tiles.
  zoomBounds?: GeodeticBounds,
): Promise<Float64Array> {
  // Pick a WM zoom roughly matching the geodetic tile's horizontal extent.
  // Geodetic tile at Z has half the longitudinal span of WM tile at the same
  // Z (Cesium has a 2x1 root), so WM zoom Z+1 lines up at the equator.
  const zoomRef = zoomBounds ?? bounds;
  const lonSpan = zoomRef.east - zoomRef.west;
  let wmZoom = Math.round(Math.log2(360 / lonSpan));
  wmZoom = Math.max(0, Math.min(demMaxZoom, wmZoom));

  // Mapterhorn's per-region coverage doesn't always reach `demMaxZoom` —
  // e.g. Lake Titicaca / Death Valley / Everest have no z>=13 tiles. If any
  // requested tile is missing, drop a zoom and retry; otherwise we'd sample
  // 0 (the geoid-only height) across a Cesium tile, producing a ~3.8 km
  // cliff at the boundary with an adjacent tile that does have z=14 data.
  let tilesByKey = new Map<string, DemTile>();
  for (; wmZoom >= 0; wmZoom--) {
    const tileCoords = wmTilesCovering(bounds, wmZoom);
    const fetches = await Promise.all(
      tileCoords.map(async ({ x, y }) => ({
        x,
        y,
        tile: await dem.read(wmZoom, x, y),
      })),
    );
    if (fetches.every((f) => f.tile !== null)) {
      tilesByKey = new Map();
      for (const { x, y, tile } of fetches) tilesByKey.set(`${x}/${y}`, tile!);
      break;
    }
  }

  const out = new Float64Array(size * size);
  if (wmZoom < 0) {
    // No coverage at any zoom — leave zeros and let the geoid grid carry it.
    return out;
  }

  for (let j = 0; j < size; j++) {
    const lat = bounds.north - (j / (size - 1)) * (bounds.north - bounds.south);
    for (let i = 0; i < size; i++) {
      const lon = bounds.west + (i / (size - 1)) * (bounds.east - bounds.west);
      out[j * size + i] = sampleAtPoint(lon, lat, wmZoom, tilesByKey);
    }
  }
  return out;
}

/** Compute the set of Web Mercator tile coords covering a lon/lat bbox. */
function wmTilesCovering(bounds: GeodeticBounds, z: number): { x: number; y: number }[] {
  const n = 1 << z;
  const x0 = Math.floor(((bounds.west + 180) / 360) * n);
  const x1 = Math.floor(((bounds.east + 180) / 360) * n);
  const y0 = latToTileY(bounds.north, z);
  const y1 = latToTileY(bounds.south, z);
  const out: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      out.push({
        x: ((x % n) + n) % n,
        y: Math.max(0, Math.min(n - 1, y)),
      });
    }
  }
  return out;
}

function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat));
  const rad = (clamped * Math.PI) / 180;
  const n = 1 << z;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
}

function sampleAtPoint(
  lon: number,
  lat: number,
  z: number,
  tiles: Map<string, DemTile>,
): number {
  const n = 1 << z;
  const xf = ((lon + 180) / 360) * n;
  const tx = ((Math.floor(xf) % n) + n) % n;
  // Clamp lat to Web Mercator domain.
  const latClamped = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat));
  const rad = (latClamped * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const ty = Math.max(0, Math.min(n - 1, Math.floor(yf)));

  const tile = tiles.get(`${tx}/${ty}`);
  if (!tile) return 0;

  const fx = (xf - Math.floor(xf)) * tile.width;
  const fy = (yf - Math.floor(yf)) * tile.height;
  return bilinearAt(tile.elevations, tile.width, tile.height, fx, fy);
}

function bilinearAt(
  data: Float32Array,
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

async function sampleGeoid(
  bucket: R2Bucket,
  key: string,
  bounds: GeodeticBounds,
  size: number,
): Promise<Float64Array> {
  const { image } = await openCog(bucket, key);
  const window = lonLatBoundsToPixelWindow(image, bounds);
  if (window.right <= window.left || window.bottom <= window.top) {
    return new Float64Array(size * size);
  }
  const rasters = await image.readRasters({
    window: [window.left, window.top, window.right, window.bottom],
    width: size,
    height: size,
    interleave: false,
    samples: [0],
  });
  const band = Array.isArray(rasters) ? rasters[0] : rasters;
  if (!band) return new Float64Array(size * size);
  const out = new Float64Array(size * size);
  // geotiff.js returns top-to-bottom; our convention is north-to-south.
  // For a north-up image those are the same, so a straight copy is fine.
  for (let i = 0; i < out.length; i++) out[i] = (band as ArrayLike<number>)[i] ?? 0;
  return out;
}

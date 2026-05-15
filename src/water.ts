// Water mask from Protomaps basemap (PMTiles + MVT).
//
// Compared to "DEM elevation <= threshold", a vector-derived mask is
// correct over polders (Netherlands, parts of Bangladesh), salt flats,
// high-altitude lakes (Titicaca, Tahoe), and rivers — none of which are
// classifiable by elevation alone.
//
// Pipeline: open a PMTiles archive via HTTP Range, locate the Web Mercator
// tiles that cover the requested geodetic bbox, decode each MVT, project
// the `water` polygons onto our 256x256 output grid, and scanline-fill
// them. The result is encoded as the Cesium watermask byte payload
// (Uniform when uniform, Grid otherwise).

import { PMTiles, FetchSource } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import type { GeodeticBounds } from "./cesium.js";

export interface WaterMaskProvider {
  buildMask(bounds: GeodeticBounds, signal?: AbortSignal): Promise<Uint8Array>;
}

// Protomaps publishes up to z=15 in the global build. Beyond that we fall
// back to z=15 tiles and rely on the polygon projection math to fill our
// 256x256 output window correctly — coords are zoom-independent so this
// works as a free upsampling step.
const MAX_PMTILES_ZOOM = 15;
const MASK_SIZE = 256;

interface WmTile {
  z: number;
  x: number;
  y: number;
  bounds: GeodeticBounds;
}

export class ProtomapsWaterMask implements WaterMaskProvider {
  #pmtiles: PMTiles;

  constructor(url: string) {
    this.#pmtiles = new PMTiles(new FetchSource(url));
  }

  async buildMask(bounds: GeodeticBounds, signal?: AbortSignal): Promise<Uint8Array> {
    const wmZoom = pickWmZoom(bounds);
    const wmTiles = wmTilesCovering(bounds, wmZoom);

    const mask = new Uint8Array(MASK_SIZE * MASK_SIZE);

    // Fetch tiles in parallel; ignore any individual failure (a missing or
    // unreadable tile just contributes "no water" to that region).
    await Promise.all(
      wmTiles.map(async (t) => {
        let resp;
        try {
          resp = await this.#pmtiles.getZxy(t.z, t.x, t.y, signal);
        } catch {
          return;
        }
        if (!resp) return;
        const vt = new VectorTile(new Pbf(new Uint8Array(resp.data)));
        const water = vt.layers["water"];
        if (!water) return;
        for (let i = 0; i < water.length; i++) {
          const f = water.feature(i);
          // type 3 = Polygon (or MultiPolygon, flattened into rings).
          if (f.type !== 3) continue;
          rasterizePolygon(f.loadGeometry(), water.extent, t, bounds, mask);
        }
      }),
    );

    return classifyMask(mask);
  }
}

function pickWmZoom(bounds: GeodeticBounds): number {
  // Width-matched: a WM tile at zoom z is 360/2^z deg wide, a Cesium
  // geodetic tile at zoom N is 360/2^(N+1) deg. Solve for z that gives
  // a WM tile of similar span to the requested bbox.
  const lonSpan = Math.max(1e-9, bounds.east - bounds.west);
  const z = Math.round(Math.log2(360 / lonSpan));
  return Math.max(0, Math.min(MAX_PMTILES_ZOOM, z));
}

function wmTilesCovering(bounds: GeodeticBounds, z: number): WmTile[] {
  const n = 1 << z;
  const xMin = Math.floor(((bounds.west + 180) / 360) * n);
  const xMax = Math.floor(((bounds.east + 180) / 360) * n);
  const yMin = latToWmY(bounds.north, n);
  const yMax = latToWmY(bounds.south, n);
  const tiles: WmTile[] = [];
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const wx = ((x % n) + n) % n;
      const wy = Math.max(0, Math.min(n - 1, y));
      tiles.push({ z, x: wx, y: wy, bounds: wmTileBounds(z, wx, wy) });
    }
  }
  return tiles;
}

function latToWmY(lat: number, n: number): number {
  const c = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat));
  const rad = (c * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
}

function wmTileBounds(z: number, x: number, y: number): GeodeticBounds {
  const n = 1 << z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { west, east, south, north };
}

/** Even-odd scanline fill, summing all rings of a polygon together. */
function rasterizePolygon(
  rings: { x: number; y: number }[][],
  extent: number,
  wm: WmTile,
  maskBounds: GeodeticBounds,
  mask: Uint8Array,
): void {
  // Project all rings into mask pixel space first.
  const projected: { x: number; y: number }[][] = rings.map((ring) =>
    ring.map((p) => projectMvtToMaskPixel(p.x, p.y, extent, wm, maskBounds)),
  );

  // Compute scanline range, clipped to the mask.
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const ring of projected) {
    for (const p of ring) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
  }
  const jMin = Math.max(0, Math.floor(yMin));
  const jMax = Math.min(MASK_SIZE - 1, Math.ceil(yMax));
  if (jMin > jMax) return;

  for (let j = jMin; j <= jMax; j++) {
    const yc = j + 0.5;
    const xs: number[] = [];
    for (const ring of projected) {
      const n = ring.length;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        if (a.y === b.y) continue;
        if ((a.y < yc && b.y >= yc) || (b.y < yc && a.y >= yc)) {
          const t = (yc - a.y) / (b.y - a.y);
          xs.push(a.x + t * (b.x - a.x));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]!));
      const x1 = Math.min(MASK_SIZE - 1, Math.floor(xs[k + 1]!));
      if (x0 > x1) continue;
      const row = j * MASK_SIZE;
      for (let x = x0; x <= x1; x++) mask[row + x] = 255;
    }
  }
}

function projectMvtToMaskPixel(
  mvtX: number,
  mvtY: number,
  extent: number,
  wm: WmTile,
  maskBounds: GeodeticBounds,
): { x: number; y: number } {
  // MVT origin is top-left of the WM tile, y growing south. lon is linear,
  // lat goes through the WM inverse for correctness near the poles / at
  // low zooms where the tile spans many degrees of latitude.
  const lon = wm.bounds.west + (mvtX / extent) * (wm.bounds.east - wm.bounds.west);
  const n = 1 << wm.z;
  const wmYNorm = (wm.y + mvtY / extent) / n;
  const rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * wmYNorm)));
  const lat = (rad * 180) / Math.PI;
  const px = ((lon - maskBounds.west) / (maskBounds.east - maskBounds.west)) * MASK_SIZE;
  const py = ((maskBounds.north - lat) / (maskBounds.north - maskBounds.south)) * MASK_SIZE;
  return { x: px, y: py };
}

function classifyMask(mask: Uint8Array): Uint8Array {
  let anyWater = false;
  let anyLand = false;
  for (const v of mask) {
    if (v === 0) anyLand = true;
    else anyWater = true;
    if (anyWater && anyLand) return mask;
  }
  if (!anyWater) return new Uint8Array([0]);
  return new Uint8Array([255]);
}

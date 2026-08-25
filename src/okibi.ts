// Tile-demand events, so something outside this worker can warm what people
// actually ask for.
//
// A miss here is about two and a half seconds where a hit is eighty-six
// milliseconds, and a version bump takes the whole prefix at once — so after
// one, every first visitor to every tile pays the difference. okibi decides
// which of those tiles are worth regenerating early, and it can only decide
// that from a record of what was asked for.
//
// One event per tile request, hits included: a hit is the evidence that
// somebody wants that tile, and a ledger of misses would only record where the
// cache failed. See https://github.com/reearth/okibi, spec/tile-demand.md.
//
// Nothing in this file may fail a tile response.

import { quadkeyForTile } from "@reearth/okibi";
import {
  type CacheLayer,
  type Epoch,
  type TileDemand,
  createWriter,
  originOf,
} from "@reearth/okibi/writer";

import epochs from "../okibi.epochs.json";

/**
 * Which grid a route's `z/x/y` are on.
 *
 * This worker serves two. The raster DEM encodings and the XYZ watermask are
 * Web Mercator; quantized mesh and `watermask-tms` are the Cesium geodetic
 * grid, two root tiles wide with y counted from the south. The same numbers
 * are different ground in each, which is the whole reason okibi projects a
 * centre point instead of comparing coordinates.
 */
export type Grid = "web-mercator" | "geographic-tms";

export interface Demand {
  /** Where the events go. Absent — no binding, as in a preview or a fork —
   *  and nothing is written. */
  dataset?: AnalyticsEngineDataset;
  /** Shared with okibi's executor, so its own requests can be told apart
   *  from somebody wanting a tile. */
  warmSecret?: string;
  /** The tileset segment of the URL. */
  tileset: string;
  /** The rest of the URL after the tileset, which is what warming fetches. */
  id: string;
  grid: Grid;
  /**
   * The parts of the cache key that are not this tile: the version prefix
   * `buildR2Key` uses, spelled the way it spells it.
   *
   * Note this can differ tile to tile — `meshCacheVersion` gives a patched
   * region its own version so a fix invalidates only the tiles it changed.
   * That is a property of the key, so it is a property of the epoch.
   */
  epoch: Epoch;
}

export interface Measured {
  cacheStatus: "hit" | "miss";
  /** Which layer had the bytes, when one did. Absent on a miss.
   *
   *  It does not change whether a tile is worth warming — a hit is somebody
   *  wanting it either way — but it changes what serving it cost: L1 is free
   *  and an R2 read is a priced operation. */
  layer?: CacheLayer | undefined;
  genMs: number;
  bytes: number;
  z: number;
  x: number;
  y: number;
  format: string;
}

/** Everything a route knows, gathered where it knows it. */
export function demandFor(env: Env, demand: Omit<Demand, "dataset" | "warmSecret">): Demand {
  return { ...demand, dataset: env.TILE_DEMAND, warmSecret: env.OKIBI_WARM_SECRET };
}

/**
 * Write one event, if the binding is there.
 *
 * Optional so that a deployment without Analytics Engine — a preview, a fork,
 * `wrangler dev` — serves tiles exactly as before.
 */
export function writeDemand(req: Request, demand: Demand, measured: Measured): void {
  if (!demand.dataset) return;

  try {
    const qk = quadkeyForTile(demand.grid, measured.z, measured.x, measured.y);

    const event: TileDemand = {
      tileset: demand.tileset,
      kind: "content",
      id: demand.id,
      qk,
      cacheStatus: measured.cacheStatus,
      cacheLayer: measured.layer,
      epoch: demand.epoch,
      fmt: measured.format,
      // Unforgeable on purpose: a mark anyone could send would let anyone
      // remove their own requests from the record of what people ask for,
      // and demand that is not recorded is demand that is never warmed.
      origin: originOf(req, demand.warmSecret),
      genMs: measured.genMs,
      bytes: measured.bytes,
      z: measured.z,
    };

    createWriter({
      dataset: demand.dataset,
      epochs,
      onError: (error) => console.warn("okibi:", error),
    }).write(event);
  } catch (error) {
    // Projection refuses a tile that is off its grid, which is a bug in a
    // caller's `grid` rather than a reason to fail the response.
    console.warn("okibi:", error);
  }
}

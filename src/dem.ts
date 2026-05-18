// DEM (Digital Elevation Model) sources.
//
// A DemSource yields a Float32 elevation grid for a given Web Mercator XYZ
// tile. The first concrete implementation pulls Terrarium-encoded WebP
// tiles from Mapterhorn (https://mapterhorn.com/), which aggregates
// NASADEM / Copernicus DEM / others into a single global terrain dataset.
//
// We keep the source-fetching path in TypeScript and hand the raw image
// bytes to a WASM function for decoding + Terrarium-to-Float32 conversion.
// That keeps R2/Fetch I/O in the Worker layer and concentrates CPU-bound
// pixel work in the WASM core.

import { decode_terrarium_webp, DecodedTile } from "./wasm/reearth-terrain-wasm/reearth_terrain_wasm.js";

export interface DemTile {
  /** Tile pixel width (Mapterhorn ships 512px tiles). */
  width: number;
  /** Tile pixel height. */
  height: number;
  /** Row-major elevation values in meters. */
  elevations: Float32Array;
}

export interface DemSource {
  readonly name: string;
  /** Returns null when the source has no coverage for this tile. */
  read(z: number, x: number, y: number, signal?: AbortSignal): Promise<DemTile | null>;
  /**
   * Optional per-tile freshness probe. Returns the upstream tile's
   * `Last-Modified` timestamp (or null when the upstream offers no
   * timestamp / the tile doesn't exist upstream). Used by `cachedTile`
   * to invalidate stale L2 entries surgically — without it the cache
   * trusts the static tileset version alone.
   */
  freshness?(z: number, x: number, y: number): Promise<Date | null>;
}

export interface MapterhornOptions {
  /** Base ZXY endpoint. Defaults to the public Mapterhorn tile server. */
  baseUrl?: string;
  /** Optional zoom limits — Mapterhorn currently publishes up to ~z14. */
  minZoom?: number;
  maxZoom?: number;
}

/**
 * DEM source backed by https://tiles.mapterhorn.com/{z}/{x}/{y}.webp.
 * Tiles are 512x512 Terrarium-encoded WebP.
 */
/**
 * LRU cap for decoded Mapterhorn tiles held in this isolate.
 * Each entry is 512x512 Float32 = 1 MiB. 32 entries ≈ 32 MiB, well under the
 * 128 MB Worker limit even with WASM, request buffers, and the EGM08 cache
 * also resident. Null (404) entries are nearly free and live in the same map.
 */
const DEM_TILE_LRU_CAPACITY = 32;

export class MapterhornSource implements DemSource {
  readonly name = "mapterhorn";
  #baseUrl: string;
  #minZoom: number;
  #maxZoom: number;
  // Single-flight map: concurrent requests for the same z/x/y share one
  // fetch + WebP decode. Entries are removed once settled, so this only
  // holds in-flight work — bounded by request fan-out, not time.
  #inflight = new Map<string, Promise<DemTile | null>>();
  // LRU cache of decoded tiles. Map preserves insertion order, so re-inserting
  // a key on access promotes it to "most recently used"; oldest is the first
  // key. WASM decode is the expensive bit being cached here — Cloudflare's
  // edge cache already absorbs the raw WebP fetch (`cacheEverything`).
  #cache = new Map<string, DemTile | null>();

  constructor(opts: MapterhornOptions = {}) {
    this.#baseUrl = opts.baseUrl ?? "https://tiles.mapterhorn.com";
    this.#minZoom = opts.minZoom ?? 0;
    this.#maxZoom = opts.maxZoom ?? 14;
  }

  read(z: number, x: number, y: number, signal?: AbortSignal): Promise<DemTile | null> {
    if (z < this.#minZoom || z > this.#maxZoom) return Promise.resolve(null);

    // AbortSignal is per-caller, so we don't forward it into the shared
    // promise — one caller aborting must not cancel the fetch for others.
    void signal;

    const key = `${z}/${x}/${y}`;

    if (this.#cache.has(key)) {
      const hit = this.#cache.get(key) ?? null;
      // Promote to MRU.
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return Promise.resolve(hit);
    }

    const existing = this.#inflight.get(key);
    if (existing) return existing;

    const promise = this.#fetchAndDecode(z, x, y).then((tile) => {
      this.#cache.set(key, tile);
      if (this.#cache.size > DEM_TILE_LRU_CAPACITY) {
        // Evict the oldest (first inserted / least recently used).
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
      return tile;
    });
    this.#inflight.set(key, promise);
    // `.finally` returns a new promise; if it rejects, awaiting only the
    // original `promise` (as callers do) leaves this branch dangling, which
    // surfaces as an unhandled rejection on failure paths. `.catch(()=>{})`
    // detaches it cleanly.
    promise.finally(() => this.#inflight.delete(key)).catch(() => {});
    return promise;
  }

  /**
   * HEAD the upstream tile and parse its `Last-Modified`. Returns null
   * when the tile is 404 or the header is missing. Used by `cachedTile`
   * to decide whether a stale L2 entry can still be trusted.
   *
   * `cf.cacheTtl: 60` collapses concurrent probes from the same edge PoP
   * onto a single upstream HEAD per minute — Cloudflare already keeps the
   * tile body cached for `max-age=604800`, so the HEAD almost always hits
   * the edge cache.
   */
  async freshness(z: number, x: number, y: number): Promise<Date | null> {
    if (z < this.#minZoom || z > this.#maxZoom) return null;
    const url = `${this.#baseUrl}/${z}/${x}/${y}.webp`;
    const res = await fetch(url, {
      method: "HEAD",
      cf: { cacheEverything: true, cacheTtl: 60 } as RequestInitCfProperties,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`mapterhorn HEAD ${url} -> ${res.status}`);
    }
    const lm = res.headers.get("last-modified");
    if (!lm) return null;
    const ts = Date.parse(lm);
    return Number.isNaN(ts) ? null : new Date(ts);
  }

  async #fetchAndDecode(z: number, x: number, y: number): Promise<DemTile | null> {
    const url = `${this.#baseUrl}/${z}/${x}/${y}.webp`;
    const res = await fetch(url, {
      cf: { cacheEverything: true, cacheTtl: 86_400 } as RequestInitCfProperties,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mapterhorn fetch ${url} -> ${res.status}`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    let decoded: DecodedTile;
    try {
      decoded = decode_terrarium_webp(bytes);
    } catch (err) {
      throw new Error(`mapterhorn webp decode failed (${url}): ${err instanceof Error ? err.message : err}`);
    }
    const width = decoded.width;
    const height = decoded.height;
    const elevations = decoded.elevations;
    return { width, height, elevations };
  }
}

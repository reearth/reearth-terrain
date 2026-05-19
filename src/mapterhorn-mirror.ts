// DEM source backed by the R2-mirrored Mapterhorn PMTiles set.
//
// Counterpart to the upstream `MapterhornSource` in `src/dem.ts`. When
// `MAPTERHORN_SOURCE=mirror` is set, `resolveTileset` swaps this
// implementation in so the read path stops depending on
// `tiles.mapterhorn.com`.
//
// Upstream Mapterhorn ships the DEM as one global archive plus
// per-z6 regional archives:
//   - planet.pmtiles                  → z0–z12 worldwide
//   - 6-{x}-{y}.pmtiles               → z13–z17 for the z6 (x, y) cell
// `reearth-terrain-mirror` snapshots each one into R2 under
// `${MAPTERHORN_MIRROR_PREFIX}/{YYYYMMDD}/{archive}` and writes a
// per-archive pointer `${archive}.latest.json` at the prefix root. This
// source reads the pointer to find the active key, opens the PMTiles
// archive over `R2PmtilesSource`, and decodes the Terrarium WebP body
// through the same WASM path as the upstream source.
//
// Per-isolate caches mirror the upstream source: an LRU of decoded
// Float32 tiles, a single-flight map keyed on z/x/y, plus two extra
// layers specific to the mirror path — a TTL'd pointer cache so we
// don't re-read `${archive}.latest.json` on every request, and a pool
// of opened `PMTiles` handles so the directory pages stay resident.

import { PMTiles } from "pmtiles";
import { R2PmtilesSource } from "./protomaps.js";
import { decode_terrarium_webp, DecodedTile } from "./wasm/reearth-terrain-wasm/reearth_terrain_wasm.js";
import type { DemSource, DemTile } from "./dem.js";

export interface MirroredMapterhornOptions {
  /** R2 prefix the mirror worker writes under. Defaults to `mirror/mapterhorn`. */
  prefix?: string;
  /** Inclusive zoom range. Defaults to the upstream range (0..17). */
  minZoom?: number;
  maxZoom?: number;
}

interface PerArchivePointer {
  archive: string;
  version: string;
  key: string;
  size: number;
}

interface PointerCacheEntry {
  // `null` records a known-missing pointer (the archive hasn't been
  // mirrored yet). Cached the same way as a hit so we don't repeatedly
  // R2-GET archives that aren't part of the active mirror set.
  value: PerArchivePointer | null;
  expires: number;
}

const PLANET_ARCHIVE = "planet.pmtiles";
const POINTER_TTL_MS = 60 * 60 * 1000;
// 32 entries × 1 MiB (512×512 Float32) ≈ 32 MiB — same shape as the
// upstream source's LRU; see the rationale comment on `MapterhornSource`.
const DEM_TILE_LRU_CAPACITY = 32;

export class MirroredMapterhornSource implements DemSource {
  readonly name = "mapterhorn-mirror";
  #r2: R2Bucket;
  #prefix: string;
  #minZoom: number;
  #maxZoom: number;
  // Pointer cache. Stores the Promise so concurrent reads for the same
  // archive coalesce onto a single R2 GET.
  #pointers = new Map<string, Promise<PointerCacheEntry>>();
  // PMTiles handles per archive. Each handle owns its own
  // directory-page cache, so reusing it across requests is the whole
  // point of keeping it around per isolate.
  #pmtiles = new Map<string, PMTiles>();
  #inflight = new Map<string, Promise<DemTile | null>>();
  #cache = new Map<string, DemTile | null>();

  constructor(r2: R2Bucket, opts: MirroredMapterhornOptions = {}) {
    this.#r2 = r2;
    this.#prefix = (opts.prefix ?? "mirror/mapterhorn").replace(/\/+$/, "");
    this.#minZoom = opts.minZoom ?? 0;
    this.#maxZoom = opts.maxZoom ?? 17;
  }

  read(z: number, x: number, y: number, signal?: AbortSignal): Promise<DemTile | null> {
    if (z < this.#minZoom || z > this.#maxZoom) return Promise.resolve(null);
    // Per-caller AbortSignal must not cancel the shared promise — same
    // reasoning as the upstream source.
    void signal;

    const key = `${z}/${x}/${y}`;
    if (this.#cache.has(key)) {
      const hit = this.#cache.get(key) ?? null;
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return Promise.resolve(hit);
    }

    const existing = this.#inflight.get(key);
    if (existing) return existing;

    const promise = this.#fetchAndDecode(z, x, y).then((tile) => {
      this.#cache.set(key, tile);
      if (this.#cache.size > DEM_TILE_LRU_CAPACITY) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
      return tile;
    });
    this.#inflight.set(key, promise);
    promise.finally(() => this.#inflight.delete(key)).catch(() => {});
    return promise;
  }

  // Intentionally no `freshness` member. Mirror snapshots are
  // version-pinned by the tileset's static version, so the
  // `cachedTile` freshness probe is bypassed entirely when this source
  // is active — flipping `MAPTERHORN_SOURCE=mirror` is expected to be
  // paired with a `Tileset.version` bump for a clean cache turnover.

  async #fetchAndDecode(z: number, x: number, y: number): Promise<DemTile | null> {
    const archive = z <= 12 ? PLANET_ARCHIVE : regionalArchiveName(z, x, y);
    const pointer = await this.#pointerFor(archive);
    if (!pointer) return null;

    let pmt = this.#pmtiles.get(archive);
    if (!pmt) {
      pmt = new PMTiles(new R2PmtilesSource(this.#r2, pointer.key));
      this.#pmtiles.set(archive, pmt);
    }

    const result = await pmt.getZxy(z, x, y);
    if (!result) return null;

    const bytes = new Uint8Array(result.data);
    let decoded: DecodedTile;
    try {
      decoded = decode_terrarium_webp(bytes);
    } catch (err) {
      throw new Error(
        `mapterhorn-mirror webp decode failed (r2://${pointer.key} z=${z} x=${x} y=${y}): ${err instanceof Error ? err.message : err}`,
      );
    }
    return { width: decoded.width, height: decoded.height, elevations: decoded.elevations };
  }

  async #pointerFor(archive: string): Promise<PerArchivePointer | null> {
    const existing = this.#pointers.get(archive);
    if (existing) {
      const entry = await existing;
      if (entry.expires > Date.now()) return entry.value;
      this.#pointers.delete(archive);
    }
    const p = this.#loadPointer(archive);
    this.#pointers.set(archive, p);
    // Detach to avoid an unhandled rejection if the load fails — the
    // awaiting caller still observes the error directly.
    p.catch(() => this.#pointers.delete(archive));
    return (await p).value;
  }

  async #loadPointer(archive: string): Promise<PointerCacheEntry> {
    const obj = await this.#r2.get(`${this.#prefix}/${archive}.latest.json`);
    const expires = Date.now() + POINTER_TTL_MS;
    if (!obj) return { value: null, expires };
    const parsed = await obj.json<PerArchivePointer>();
    if (!parsed?.key || !parsed?.archive) {
      throw new Error(`malformed pointer at ${this.#prefix}/${archive}.latest.json`);
    }
    return { value: parsed, expires };
  }
}

function regionalArchiveName(z: number, x: number, y: number): string {
  const shift = z - 6;
  return `6-${x >> shift}-${y >> shift}.pmtiles`;
}

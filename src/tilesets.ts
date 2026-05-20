// Tileset registry.
//
// A "tileset" names a specific combination of DEM source + geoid model +
// versioning policy. The URL shape is
//   /{tileset}/{encoding}/{data_type}/{z}/{x}/{y}.{format}
// with an alias path that omits the tileset segment and resolves to the
// default tileset for backward compatibility.
//
// `version` is intentionally not exposed in the URL — keeping it in
// configuration matches the architecture document: bumping it changes the
// cache key prefix and lets old entries age out via R2 lifecycle without
// any client-visible breakage.

import { MapterhornSource, type DemSource } from "./dem.js";
import { HybridMapterhornSource, MirroredMapterhornSource } from "./mapterhorn-mirror.js";

export interface Attribution {
  name: string;
  url?: string;
}

/**
 * Optional watermask configuration. The actual URL and version are resolved
 * at request time by `src/protomaps.ts` (HEAD probe + 1 h in-memory cache),
 * so the upstream build can rotate daily without code or cache changes.
 *
 * Only the source-kind label and the credits live on the tileset. Both feed
 * into the cache key and the layer.json attribution so a future provider
 * swap will read as a clean ETag bump.
 */
export interface WatermaskSource {
  /** Provider identity — also folded into the cache-key prefix. */
  kind: "protomaps-daily";
  /** Credits to inject into TileJSON / Cesium layer.json. */
  attribution: Attribution[];
}

export interface Tileset {
  /** URL-safe identifier. */
  name: string;
  /** Bumped to invalidate downstream caches. Format is intentionally free. */
  version: string;
  /**
   * Optional geoid-specific revision. Bumped independently from `version`
   * when only the geoid COG changes (e.g., re-tiling EGM08 or swapping in
   * a newer geoid model). When set, it gets folded into the cache key as
   * a `-g{geoidVersion}` suffix, so flipping it rotates the prefix exactly
   * like a `version` bump — but without invalidating DEM-only entries that
   * happen to share the same `version`. Leave unset on a fresh tileset to
   * keep the cache prefix simple (`v{version}/`); introduce it the first
   * time the geoid needs to be invalidated independently.
   */
  geoidVersion?: string;
  /** Human-readable description for TileJSON `description`. */
  description: string;
  /** Source attributions, surfaced in TileJSON. */
  attribution: Attribution[];
  /** Underlying DEM provider. */
  dem: DemSource;
  /** R2 key of the geoid COG (currently EPSG:4979 float32). */
  geoidKey: string;
  /** Optional Protomaps-derived watermask source. */
  watermask?: WatermaskSource;
  minZoom: number;
  maxZoom: number;
}

const upstreamMapterhorn = new MapterhornSource();

// One mirror-backed source per R2 binding. WeakMap so the entry goes
// away with the binding instead of pinning it across isolate reloads.
// Reusing the instance across requests is what keeps the per-archive
// PMTiles directory pages and the decoded-tile LRU resident.
const mirrorMapterhornByR2 = new WeakMap<R2Bucket, MirroredMapterhornSource>();
function mirrorMapterhornFor(env: Env): MirroredMapterhornSource {
  let inst = mirrorMapterhornByR2.get(env.R2);
  if (!inst) {
    inst = new MirroredMapterhornSource(env.R2, {
      prefix: env.MAPTERHORN_MIRROR_PREFIX || "mirror/mapterhorn",
    });
    mirrorMapterhornByR2.set(env.R2, inst);
  }
  return inst;
}

// Hybrid source reuses the same per-R2 mirror instance so the PMTiles
// handle pool and decoded-tile LRU stay shared with pure-mirror reads
// during a mode flip.
const hybridMapterhornByR2 = new WeakMap<R2Bucket, HybridMapterhornSource>();
function hybridMapterhornFor(env: Env): HybridMapterhornSource {
  let inst = hybridMapterhornByR2.get(env.R2);
  if (!inst) {
    inst = new HybridMapterhornSource(mirrorMapterhornFor(env), upstreamMapterhorn, env.R2, {
      prefix: env.MAPTERHORN_MIRROR_PREFIX || "mirror/mapterhorn",
    });
    hybridMapterhornByR2.set(env.R2, inst);
  }
  return inst;
}

const PROTOMAPS_WATERMASK: WatermaskSource = {
  kind: "protomaps-daily",
  attribution: [
    { name: "Protomaps", url: "https://protomaps.com/" },
    { name: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright" },
  ],
};

const MAPTERHORN_EGM08: Tileset = {
  name: "mapterhorn-egm08",
  version: "5",
  description:
    "Mapterhorn-merged global DEM blended with EGM2008 geoid undulations.",
  attribution: [
    { name: "Re:Earth Terrain", url: "https://terrain.reearth.land/" },
    { name: "Mapterhorn", url: "https://mapterhorn.com/" },
    { name: "EGM2008 (NGA)", url: "https://earth-info.nga.mil/" },
  ],
  dem: upstreamMapterhorn,
  geoidKey: "sources/egm08_cog.tif",
  watermask: PROTOMAPS_WATERMASK,
  minZoom: 0,
  maxZoom: 14,
};

export const TILESETS: Record<string, Tileset> = {
  [MAPTERHORN_EGM08.name]: MAPTERHORN_EGM08,
};

export const DEFAULT_TILESET = MAPTERHORN_EGM08.name;

/**
 * Resolve a tileset by name, optionally swapping its DEM source for
 * the R2-mirrored implementation when `env.MAPTERHORN_SOURCE=mirror`.
 *
 * The returned object is either the canonical `TILESETS` entry
 * (untouched, so reference equality still works for cached lookups
 * elsewhere) or a shallow copy with `dem` rebound to the mirror source.
 * The `env` parameter is optional so non-request callers (tests,
 * tooling) still get the upstream-backed default.
 */
export function resolveTileset(name: string | undefined, env?: Env): Tileset | null {
  const key = name ?? DEFAULT_TILESET;
  const base = TILESETS[key];
  if (!base) return null;
  if (env?.R2 && base.dem === upstreamMapterhorn) {
    if (env.MAPTERHORN_SOURCE === "mirror") return { ...base, dem: mirrorMapterhornFor(env) };
    if (env.MAPTERHORN_SOURCE === "hybrid") return { ...base, dem: hybridMapterhornFor(env) };
  }
  return base;
}

/**
 * Compose a tileset's full cache-key version string. The static
 * `Tileset.version` is always the leading segment; an optional
 * `Tileset.geoidVersion` appends a `-g{value}` suffix when set, providing
 * a knob that operators can flip to invalidate the geoid component without
 * touching the primary `version` (or vice versa).
 *
 * Mapterhorn DEM freshness is NOT handled here — DEM updates are regional,
 * so we validate per-tile against the upstream `Last-Modified` instead of
 * rotating the whole prefix. See `cachedTile`'s freshness probe in
 * `src/cache.ts` and `MapterhornSource.freshness` in `src/dem.ts`.
 */
export function resolveTilesetVersion(t: Tileset): string {
  return t.geoidVersion ? `${t.version}-g${t.geoidVersion}` : t.version;
}

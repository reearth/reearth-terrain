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

const mapterhorn = new MapterhornSource();

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
  dem: mapterhorn,
  geoidKey: "sources/egm08_cog.tif",
  watermask: PROTOMAPS_WATERMASK,
  minZoom: 0,
  maxZoom: 14,
};

export const TILESETS: Record<string, Tileset> = {
  [MAPTERHORN_EGM08.name]: MAPTERHORN_EGM08,
};

export const DEFAULT_TILESET = MAPTERHORN_EGM08.name;

export function resolveTileset(name: string | undefined): Tileset | null {
  const key = name ?? DEFAULT_TILESET;
  return TILESETS[key] ?? null;
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

// Protomaps PMTiles daily-build resolver.
//
// The published archives at build.protomaps.com expire after roughly one
// week (and the Protomaps team discourages hotlinking). Hard-coding a date
// would leave us with a 404 every few days, so this module HEAD-probes
// `${YYYYMMDD}.pmtiles` walking back from today and memoizes the first OK
// response for an hour per worker instance.
//
// The resolved date selects which archive to read; the cache key is
// derived per-tile from PMTiles directory entries (see
// `ProtomapsWaterMask.tileLocators`) so daily rebuilds only invalidate
// the watermask-bearing entries whose underlying byte ranges actually
// moved.
//
// Ported from reearth-buildings' apps/worker/src/version.ts which solves
// the same problem for its glb pipeline.

const UPSTREAM_BASE = "https://build.protomaps.com";
const MAX_PROBE_DAYS = 7;
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CachedDate {
  value: string;
  expires: number;
}

let memoryCache: CachedDate | null = null;

/**
 * Return today's (or the most recent published) Protomaps build date as
 * `YYYYMMDD`. Uses the in-memory cache first, falls back to a fresh probe.
 */
export async function currentPmtilesDate(): Promise<string> {
  const now = Date.now();
  if (memoryCache && memoryCache.expires > now) return memoryCache.value;
  const fresh = await probeLatestDate();
  memoryCache = { value: fresh, expires: now + CACHE_TTL_MS };
  return fresh;
}

export function pmtilesUrlForDate(date: string): string {
  return `${UPSTREAM_BASE}/${date}.pmtiles`;
}

async function probeLatestDate(): Promise<string> {
  const now = Date.now();
  for (let i = 0; i < MAX_PROBE_DAYS; i++) {
    const ts = now - i * 86_400_000;
    const date = formatUtcDate(new Date(ts));
    // `cf: cacheEverything` collapses concurrent probes on the same edge
    // PoP onto a single upstream HEAD per minute.
    const r = await fetch(pmtilesUrlForDate(date), {
      method: "HEAD",
      cf: { cacheTtl: 60, cacheEverything: true },
    } as RequestInit);
    if (r.ok) return date;
  }
  throw new Error(
    `no recent Protomaps PMTiles build found at ${UPSTREAM_BASE} within ${MAX_PROBE_DAYS} days`,
  );
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}

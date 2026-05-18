// Protomaps PMTiles source resolver.
//
// The watermask reads from one Protomaps PMTiles archive. Two backends
// are supported:
//
//   - `upstream` (default): HEAD-probe `${YYYYMMDD}.pmtiles` at
//     build.protomaps.com walking back from today, then read via Range
//     fetches. The published archives expire after roughly one week,
//     so the date is rediscovered hourly in-memory.
//
//   - `mirror`: read a snapshot maintained by the `reearth-terrain-mirror`
//     worker. The pointer file `${MIRROR_PREFIX}/latest.json` in R2
//     names the active archive; we read it once per worker instance and
//     serve byte ranges directly from R2. Insulates the service from
//     upstream retention and outages, at the cost of running a separate
//     worker that copies the archive on a monthly cadence.
//
// The resolved Source selects which archive to read; the cache key is
// derived per-tile from PMTiles directory entries (see
// `ProtomapsWaterMask.tileLocators`) so build rotations only invalidate
// the watermask-bearing entries whose underlying byte ranges actually
// moved.

import type { RangeResponse, Source } from "pmtiles";
import { FetchSource } from "pmtiles";

const UPSTREAM_BASE = "https://build.protomaps.com";
const MAX_PROBE_DAYS = 7;
const CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MIRROR_PREFIX = "mirror/protomaps";

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

/**
 * PMTiles `Source` backed by an R2 object. Issues `R2Bucket.get` with a
 * `range` option per `getBytes` call. Used when `PROTOMAPS_SOURCE=mirror`
 * — the mirror worker has already copied the archive into R2 under
 * `${MIRROR_PREFIX}/{date}.pmtiles`.
 */
export class R2PmtilesSource implements Source {
  #bucket: R2Bucket;
  #key: string;
  #identity: string;

  constructor(bucket: R2Bucket, key: string) {
    this.#bucket = bucket;
    this.#key = key;
    // Stable, archive-scoped identity so the pmtiles cache layer keys
    // header / directory entries against this specific R2 object rather
    // than mixing them with FetchSource entries.
    this.#identity = `r2://${key}`;
  }

  getKey(): string {
    return this.#identity;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.#bucket.get(this.#key, {
      range: { offset, length },
    });
    if (!obj) throw new Error(`pmtiles archive not found in R2: ${this.#key}`);
    const data = await obj.arrayBuffer();
    return {
      data,
      etag: obj.httpEtag,
    };
  }
}

/**
 * The pointer file that the mirror worker writes after a successful run.
 * Only the fields read by the main worker are listed.
 */
export interface PmtilesMirrorPointer {
  date: string;
  key: string;
  size: number;
}

interface CachedPointer {
  value: PmtilesMirrorPointer;
  expires: number;
}

let mirrorPointerCache: CachedPointer | null = null;

/**
 * Read `${prefix}/latest.json` from R2 with the same hourly TTL used for
 * the upstream date probe. Reads are scoped to the worker instance — a
 * fresh instance pays one R2 GET on first request, after that it's
 * memoized.
 */
export async function readMirrorPointer(
  bucket: R2Bucket,
  prefix = DEFAULT_MIRROR_PREFIX,
): Promise<PmtilesMirrorPointer> {
  const now = Date.now();
  if (mirrorPointerCache && mirrorPointerCache.expires > now) {
    return mirrorPointerCache.value;
  }
  const obj = await bucket.get(`${prefix}/latest.json`);
  if (!obj) {
    throw new Error(
      `mirror pointer ${prefix}/latest.json not found — run the mirror worker at least once`,
    );
  }
  const parsed = await obj.json<PmtilesMirrorPointer>();
  if (!parsed?.key || !parsed?.date) {
    throw new Error(`mirror pointer ${prefix}/latest.json is malformed`);
  }
  mirrorPointerCache = { value: parsed, expires: now + CACHE_TTL_MS };
  return parsed;
}

/** Test-only: drop the in-memory pointer cache between cases. */
export function __resetMirrorPointerCache(): void {
  mirrorPointerCache = null;
}

/**
 * Resolve the PMTiles archive to read, honoring `PROTOMAPS_SOURCE`.
 *
 *   PROTOMAPS_SOURCE="mirror"   → R2 snapshot
 *   anything else (default)     → upstream daily build
 *
 * Returns the pmtiles `Source` plus a short tag (date string for both
 * backends) used to derive cache keys and human-readable URLs.
 */
export async function resolvePmtilesSource(env: {
  R2?: R2Bucket;
  PROTOMAPS_SOURCE?: string;
  MIRROR_PREFIX?: string;
}): Promise<{ source: Source; tag: string; sourceUrl: string }> {
  if (env.PROTOMAPS_SOURCE === "mirror") {
    if (!env.R2) throw new Error("PROTOMAPS_SOURCE=mirror requires the R2 binding");
    const pointer = await readMirrorPointer(env.R2, env.MIRROR_PREFIX || DEFAULT_MIRROR_PREFIX);
    const source = new R2PmtilesSource(env.R2, pointer.key);
    return { source, tag: pointer.date, sourceUrl: `r2://${pointer.key}` };
  }
  const date = await currentPmtilesDate();
  const url = pmtilesUrlForDate(date);
  return { source: new FetchSource(url), tag: date, sourceUrl: url };
}

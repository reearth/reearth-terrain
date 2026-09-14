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
import { countRead } from "./r2-reads.js";
import { cachedRange } from "./range-cache.js";
import { READ_TIMEOUT_MS, shared } from "./single-flight.js";

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
 * How much of the archive one R2 read pulls in. PMTiles lays tiles out in
 * Hilbert order, so tiles that are near each other on the map are near each
 * other in the file: a request for one tile is a good predictor of the next.
 * R2 bills class B per operation and does not bill egress here, so reading a
 * megabyte to answer a 4 KB question costs nothing extra and saves every
 * neighbouring read that follows.
 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Budget for chunks held in the isolate, across every archive.
 *
 * Deliberately not per-source. `MapterhornMirror` keeps one `PMTiles` — and
 * so one source — per regional archive in an unbounded map, and a request
 * whose points are spread over the globe touches forty of them. A per-source
 * budget would multiply by that; the isolate has 128 MB and src/cesium.ts
 * records what running into that looks like.
 */
const CHUNK_CACHE_BYTES = 16 * 1024 * 1024;

/** Cached chunks, keyed `${r2 key}#${chunk index}`, LRU by insertion order. */
const chunkCache = new Map<string, Uint8Array>();
let chunkCacheBytes = 0;
const chunkInflight = new Map<string, Promise<Uint8Array>>();

/** Test-only: drop the shared chunk cache between cases. */
export function __resetChunkCache(): void {
  chunkCache.clear();
  chunkInflight.clear();
  chunkCacheBytes = 0;
}

/**
 * PMTiles `Source` backed by an R2 object. Used when
 * `PROTOMAPS_SOURCE=mirror` — the mirror worker has already copied the
 * archive into R2 under `${MIRROR_PREFIX}/{date}.pmtiles`.
 *
 * Reads are served out of aligned chunks rather than issued one per
 * `getBytes` call. A sparse-point request touches a few hundred tiles that
 * are spatially adjacent and therefore land in a handful of chunks; without
 * this each of them was its own billable class B operation.
 */
export class R2PmtilesSource implements Source {
  #bucket: R2Bucket;
  #key: string;
  #identity: string;
  #etag: string | undefined;
  #size: number | undefined;

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
    // A read larger than a chunk would evict most of the cache to hold one
    // answer nobody is going to ask for again. Pass it straight through.
    if (length > CHUNK_BYTES) {
      const data = await this.#read(offset, length);
      return { data: data.buffer as ArrayBuffer, etag: this.#etag };
    }

    const first = Math.floor(offset / CHUNK_BYTES);
    const last = Math.floor((offset + length - 1) / CHUNK_BYTES);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) => this.#chunk(first + i)),
    );

    const out = new Uint8Array(length);
    let written = 0;
    for (const [i, part] of parts.entries()) {
      const chunkStart = (first + i) * CHUNK_BYTES;
      const from = Math.max(0, offset - chunkStart);
      const to = Math.min(part.byteLength, offset + length - chunkStart);
      if (to <= from) continue;
      out.set(part.subarray(from, to), written);
      written += to - from;
    }
    // The archive can end mid-chunk; hand back only what actually exists.
    const data = written === length ? out.buffer : out.buffer.slice(0, written);
    return { data, etag: this.#etag };
  }

  #chunk(index: number): Promise<Uint8Array> {
    const id = `${this.#key}#${index}`;
    const cached = chunkCache.get(id);
    if (cached) {
      // Refresh recency so the chunks a burst of tiles keeps landing in are
      // the last ones evicted.
      chunkCache.delete(id);
      chunkCache.set(id, cached);
      return Promise.resolve(cached);
    }

    // Sparse-point requests fan out over tiles in parallel, so without this
    // the same chunk would be bought several times over concurrently. The map
    // is module-scoped and outlives the request, so the sharing goes through
    // `shared` — see src/single-flight.ts.
    return shared(
      chunkInflight,
      id,
      async () => {
        const bytes = await this.#read(index * CHUNK_BYTES, CHUNK_BYTES);
        remember(id, bytes);
        return bytes;
      },
      { timeoutMs: READ_TIMEOUT_MS, keepResolved: false },
    );
  }

  async #read(offset: number, length: number): Promise<Uint8Array> {
    // Through the colo's cache first, for the reason src/range-cache.ts gives:
    // the chunk map above belongs to this isolate and dies with it.
    const bytes = await cachedRange(this.#key, offset, length, async () => {
      const read = await this.#readFromR2(offset, length);
      const copy = new Uint8Array(read.byteLength);
      copy.set(read);
      return copy.buffer;
    });
    return new Uint8Array(bytes);
  }

  async #readFromR2(offset: number, length: number): Promise<Uint8Array> {
    // The chunk grid does not stop where the archive does: a caller asking
    // for the last few bytes can pull in the chunk after the one holding
    // them. R2 answers a range that starts at or past the end of an object
    // with null, which is the same answer it gives for an object that isn't
    // there — so ask only when we don't already know the size.
    if (this.#size !== undefined && offset >= this.#size) return new Uint8Array(0);

    countRead(this.#key, length);
    const obj = await this.#bucket.get(this.#key, { range: { offset, length } });
    if (!obj) {
      const meta = await this.#bucket.head(this.#key);
      if (meta) {
        this.#size = meta.size;
        if (offset >= meta.size) return new Uint8Array(0);
      }
      throw new Error(`pmtiles archive not found in R2: ${this.#key}`);
    }
    this.#etag ??= obj.httpEtag;
    this.#size ??= obj.size;
    return new Uint8Array(await obj.arrayBuffer());
  }

}

function remember(id: string, bytes: Uint8Array): void {
  chunkCache.set(id, bytes);
  chunkCacheBytes += bytes.byteLength;
  while (chunkCacheBytes > CHUNK_CACHE_BYTES) {
    const oldest = chunkCache.keys().next();
    if (oldest.done) break;
    const evicted = chunkCache.get(oldest.value)!;
    chunkCache.delete(oldest.value);
    chunkCacheBytes -= evicted.byteLength;
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

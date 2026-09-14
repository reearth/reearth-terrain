// COG (Cloud Optimized GeoTIFF) reader backed by an R2 bucket.
//
// geotiff.js drives I/O through its `BaseSource` abstraction. We implement
// one that issues byte-range reads against an R2Bucket binding so the Worker
// only fetches the chunks it needs (header + relevant tile strips) rather
// than the whole file.
//
// We avoid importing geotiff internals — `geotiff/package.json` only exports
// the top-level entry — and instead duck-type the Source interface.
// `GeoTIFF.fromSource()` only calls `source.fetch([slice...], signal)`, so
// that is all we strictly need to expose.

import GeoTIFF, { type GeoTIFFImage } from "geotiff";

import { countRead } from "./r2-reads.js";
import { OPEN_TIMEOUT_MS, READ_TIMEOUT_MS, shared } from "./single-flight.js";

export interface Slice {
  offset: number;
  length: number;
}

// Two ranges separated by less than this are fetched as one. A gap costs us
// the bytes we throw away; a split costs a whole class B operation, and at
// $0.36/M against R2's per-request overhead the bytes are much the cheaper
// side of that trade well past a few KiB.
const COALESCE_GAP = 16 * 1024;

// Per-source budget for remembering bytes we've already paid for. The geoid
// COG is read at scattered points within the same few tiles, so the same
// ranges come back over and over; without this every point re-fetches them.
// 8 MiB leaves plenty of headroom under the Worker's 128 MB limit.
const SLICE_CACHE_BYTES = 8 * 1024 * 1024;

interface CogSource {
  fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBufferLike[]>;
  fetchSlice(slice: Slice, signal?: AbortSignal): Promise<{ offset: number; length: number; data: ArrayBufferLike }>;
  readonly fileSize: number | null;
  close(): Promise<void>;
}

export interface ReadGroup {
  offset: number;
  end: number;
  /** Indices into the original slice array, in no particular order. */
  members: number[];
}

/**
 * Decide which of these byte ranges can share one read. Ranges are grouped
 * in offset order, and a new group starts only where the gap to the previous
 * one is wider than `gap` — past that the bytes we'd skip over cost more than
 * the extra request saves.
 */
export function planReads(slices: Slice[], gap: number): ReadGroup[] {
  const order = slices
    .map((_, i) => i)
    .sort((a, b) => slices[a]!.offset - slices[b]!.offset);

  const groups: ReadGroup[] = [];
  for (const i of order) {
    const s = slices[i]!;
    const last = groups[groups.length - 1];
    if (last && s.offset <= last.end + gap) {
      last.end = Math.max(last.end, s.offset + s.length);
      last.members.push(i);
    } else {
      groups.push({ offset: s.offset, end: s.offset + s.length, members: [i] });
    }
  }
  return groups;
}

class R2CogSource implements CogSource {
  #bucket: R2Bucket;
  #key: string;
  #fileSize: number | null = null;
  #sizeProbe: Promise<number | null> | null = null;
  // Insertion order is eviction order: least recently used first.
  #cache = new Map<string, ArrayBuffer>();
  #cacheBytes = 0;
  #inflight = new Map<string, Promise<ArrayBuffer>>();

  constructor(bucket: R2Bucket, key: string) {
    this.#bucket = bucket;
    this.#key = key;
  }

  // geotiff.js hands this a batch of slices. Ranges that sit close together
  // are fetched as one R2 read and handed back out as separate buffers, so a
  // batch of twenty neighbouring strips costs one class B operation instead
  // of twenty. The tally in src/r2-reads.ts counts what actually goes out.
  async fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBufferLike[]> {
    if (slices.length <= 1) {
      return Promise.all(
        slices.map(async (s) => (await this.fetchSlice(s, signal)).data),
      );
    }

    const groups = planReads(slices, COALESCE_GAP);
    const out: ArrayBufferLike[] = new Array(slices.length);
    await Promise.all(
      groups.map(async (g) => {
        const { data } = await this.fetchSlice(
          { offset: g.offset, length: g.end - g.offset },
          signal,
        );
        const bytes = new Uint8Array(data);
        for (const i of g.members) {
          const s = slices[i]!;
          const from = s.offset - g.offset;
          // R2 clamps at EOF, so the group may be short of what we asked for;
          // hand back whatever of this range actually arrived.
          const to = Math.min(from + s.length, bytes.byteLength);
          out[i] = bytes.slice(Math.min(from, bytes.byteLength), to).buffer;
        }
      }),
    );
    return out;
  }

  async fetchSlice(slice: Slice, _signal?: AbortSignal) {
    const cacheKey = `${slice.offset}:${slice.length}`;
    const hit = this.#cache.get(cacheKey);
    if (hit) {
      // Refresh recency so the ranges a burst of points keeps asking for are
      // the last ones to be evicted.
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, hit);
      return { offset: slice.offset, length: hit.byteLength, data: hit.slice(0) };
    }

    // Blocks are read in parallel and neighbouring blocks share the tiles on
    // their common edge, so without this the same range would be bought
    // several times over at once. This source outlives the request that built
    // it, so the sharing goes through `shared` — see src/single-flight.ts.
    const buf = await shared(
      this.#inflight,
      cacheKey,
      async () => {
        const bytes = await this.#read(slice);
        this.#remember(cacheKey, bytes);
        return bytes;
      },
      { timeoutMs: READ_TIMEOUT_MS, keepResolved: false },
    );
    return { offset: slice.offset, length: buf.byteLength, data: buf.slice(0) };
  }

  async #read(slice: Slice): Promise<ArrayBuffer> {
    // Every one of these is a billable class B operation, and together they
    // are the largest line on this account's bill.
    countRead(this.#key, slice.length);
    const obj = await this.#bucket.get(this.#key, {
      range: { offset: slice.offset, length: slice.length },
    });
    if (!obj) throw new Error(`R2 object not found: ${this.#key}`);

    if (this.#fileSize === null && obj.size != null) {
      this.#fileSize = obj.size;
    }
    return obj.arrayBuffer();
  }

  #remember(key: string, buf: ArrayBuffer): void {
    if (buf.byteLength > SLICE_CACHE_BYTES) return;
    // Overwriting an entry replaces bytes already counted; drop the old
    // figure first or the budget drifts upward and evicts everything.
    const previous = this.#cache.get(key);
    if (previous) this.#cacheBytes -= previous.byteLength;
    this.#cache.set(key, buf.slice(0));
    this.#cacheBytes += buf.byteLength;
    while (this.#cacheBytes > SLICE_CACHE_BYTES) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      const evicted = this.#cache.get(oldest.value)!;
      this.#cache.delete(oldest.value);
      this.#cacheBytes -= evicted.byteLength;
    }
  }

  get fileSize(): number | null {
    return this.#fileSize;
  }

  /** Probe the object size up front so reads can be clamped. */
  async probeSize(): Promise<number | null> {
    if (this.#fileSize !== null) return this.#fileSize;
    this.#sizeProbe ??= this.#bucket
      .head(this.#key)
      .then((meta) => (meta ? (this.#fileSize = meta.size) : null))
      .catch(() => null);
    return this.#sizeProbe;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

export interface OpenCogOptions {
  /** If true, perform a HEAD probe on open to learn fileSize. */
  probeSize?: boolean;
}

export interface OpenedCog {
  tiff: GeoTIFF;
  image: GeoTIFFImage;
}

// Module-scope memo of opened COGs. Workers reuse the same isolate across
// requests on a single machine, so caching the parsed IFD + first image lets
// subsequent reads skip the header GETs and reuse geotiff.js's internal tile
// cache. We store the promise itself for single-flight: concurrent first
// callers all await the same `fromSource`/`getImage` pipeline.
//
// It goes through `shared` because a promise here outlives the request that
// created it, and one left pending by a request that went away would never
// settle — poisoning this key for the rest of the isolate's life. See
// src/single-flight.ts.
//
// Key is the R2 object key; this worker only binds one bucket. If that ever
// changes, include the bucket identity in the key.
const openedCogs = new Map<string, Promise<OpenedCog>>();

/** Open a COG stored in R2 and return its first (highest-resolution) image. */
export function openCog(
  bucket: R2Bucket,
  key: string,
  opts: OpenCogOptions = {},
): Promise<OpenedCog> {
  return shared(
    openedCogs,
    key,
    async () => {
      const source = new R2CogSource(bucket, key);
      if (opts.probeSize) await source.probeSize();
      const tiff = await GeoTIFF.fromSource(
        source as unknown as Parameters<typeof GeoTIFF.fromSource>[0],
      );
      const image = await tiff.getImage();
      return { tiff, image };
    },
    { timeoutMs: OPEN_TIMEOUT_MS },
  );
}

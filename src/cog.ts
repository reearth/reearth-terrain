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

interface Slice {
  offset: number;
  length: number;
}

interface CogSource {
  fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBufferLike[]>;
  fetchSlice(slice: Slice, signal?: AbortSignal): Promise<{ offset: number; length: number; data: ArrayBufferLike }>;
  readonly fileSize: number | null;
  close(): Promise<void>;
}

class R2CogSource implements CogSource {
  #bucket: R2Bucket;
  #key: string;
  #fileSize: number | null = null;
  #sizeProbe: Promise<number | null> | null = null;

  constructor(bucket: R2Bucket, key: string) {
    this.#bucket = bucket;
    this.#key = key;
  }

  async fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBufferLike[]> {
    return Promise.all(
      slices.map(async (s) => (await this.fetchSlice(s, signal)).data),
    );
  }

  async fetchSlice(slice: Slice, _signal?: AbortSignal) {
    const obj = await this.#bucket.get(this.#key, {
      range: { offset: slice.offset, length: slice.length },
    });
    if (!obj) throw new Error(`R2 object not found: ${this.#key}`);

    if (this.#fileSize === null && obj.size != null) {
      this.#fileSize = obj.size;
    }
    const buf = await obj.arrayBuffer();
    return { offset: slice.offset, length: buf.byteLength, data: buf };
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
// Key is the R2 object key; this worker only binds one bucket. If that ever
// changes, include the bucket identity in the key.
const openedCogs = new Map<string, Promise<OpenedCog>>();

/** Open a COG stored in R2 and return its first (highest-resolution) image. */
export function openCog(
  bucket: R2Bucket,
  key: string,
  opts: OpenCogOptions = {},
): Promise<OpenedCog> {
  const cached = openedCogs.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const source = new R2CogSource(bucket, key);
    if (opts.probeSize) await source.probeSize();
    const tiff = await GeoTIFF.fromSource(source as unknown as Parameters<typeof GeoTIFF.fromSource>[0]);
    const image = await tiff.getImage();
    return { tiff, image };
  })();

  openedCogs.set(key, promise);
  promise.catch(() => openedCogs.delete(key));
  return promise;
}

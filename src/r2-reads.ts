// Counting the R2 reads one request makes.
//
// Class B operations are the largest line on this account's bill by a wide
// margin — about four fifths of it — and almost none of them are the read
// that serves a cached tile. They are the reads that *build* one: a mesh
// samples a DEM and a geoid out of Cloud Optimized GeoTIFFs, and every byte
// range geotiff.js asks for is a separate `bucket.get()` and a separate
// billable operation.
//
// How many that is per tile was, until this existed, a number nobody had.
// Subtracting cached hits from the daily total put it somewhere between 130
// and 280, which is wide enough to be useless for deciding what to fix: a
// coalescing read, a block cache and a shared halo are three different
// changes and the arithmetic does not say which one to make.
//
// So: count them per request, attributed to the key they were read from, and
// log the tally beside the tile that caused it.
//
// `AsyncLocalStorage` rather than a module-level counter, because a Worker
// isolate serves many requests at once and a global would add up the ones
// that happened to overlap. The store is created per request and the reads
// inherit it through the promise chain.

import { AsyncLocalStorage } from "node:async_hooks";

export interface ReadTally {
  /** Reads per R2 key, so the geoid and the DEM mirror are told apart. */
  byKey: Map<string, number>;
  /** Bytes asked for, which says whether the reads are small and many. */
  bytes: number;
}

const store = new AsyncLocalStorage<ReadTally>();

/** Run `fn` with a fresh tally, and hand it back alongside the result. */
export async function counting<T>(fn: () => Promise<T>): Promise<{ value: T; tally: ReadTally }> {
  const tally: ReadTally = { byKey: new Map(), bytes: 0 };
  const value = await store.run(tally, fn);
  return { value, tally };
}

/** Record one `bucket.get()`. Does nothing outside a `counting` scope. */
export function countRead(key: string, bytes: number): void {
  const tally = store.getStore();
  if (!tally) return;
  tally.byKey.set(key, (tally.byKey.get(key) ?? 0) + 1);
  tally.bytes += bytes;
}

export function totalReads(tally: ReadTally): number {
  let n = 0;
  for (const count of tally.byKey.values()) n += count;
  return n;
}

/**
 * Say what a tile cost to build, when it cost anything.
 *
 * Only on a miss, and only when reads actually happened: logging a line for
 * every cache hit would be twenty million lines a day saying zero.
 */
export function reportReads(what: Record<string, unknown>, tally: ReadTally): void {
  const total = totalReads(tally);
  if (total === 0) return;

  console.log("r2 reads", {
    ...what,
    reads: total,
    kb: Math.round(tally.bytes / 1024),
    perKey: Object.fromEntries(
      [...tally.byKey].sort((a, b) => b[1] - a[1]).map(([k, n]) => [shorten(k), n]),
    ),
  });
}

/** The tail of a key is the part that differs; the prefix is noise in a log. */
function shorten(key: string): string {
  const parts = key.split("/");
  return parts.length <= 2 ? key : `…/${parts.slice(-2).join("/")}`;
}

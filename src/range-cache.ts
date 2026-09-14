// Byte ranges, kept where they survive the isolate that fetched them.
//
// Both readers already remember the bytes they have paid for — the COG source
// in src/cog.ts and the pmtiles source in src/protomaps.ts — but only for as
// long as their isolate lives. A cold isolate starts by buying everything
// again, and isolates are replaced often enough that this is most of what is
// left on the bill.
//
// The Cache API is the right shelf for it: it belongs to the data centre
// rather than to one isolate, so what one request pays for, the next request
// through that colo gets free. It costs no R2 operation and it holds the
// object until the TTL runs out.
//
// Two things bound it. Cache API calls share the subrequest quota — 1,000 per
// request on the paid plan — and a scattered point request was measured making
// 628 R2 reads, which at a lookup and a store apiece would run past that. So
// each request gets a budget, and past it the cache is simply skipped: the
// read still happens, it is just not helped. And the cache is keyed by object
// key and byte range, not by content, so an object replaced in place under the
// same key would be served from the old bytes until the TTL expires. Every key
// this reads is either date-stamped (the pmtiles mirror) or a static source
// file, but a deliberate replacement still wants the TTL waited out.

import { AsyncLocalStorage } from "node:async_hooks";

/** How long a range stays on the colo's shelf. */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Cache operations one request may make. Two per read — a lookup and a store —
 * against a 1,000 limit shared with R2 and every other subrequest, leaving
 * room for the reads themselves.
 */
const OPS_PER_REQUEST = 600;

interface Budget {
  left: number;
}

const budgets = new AsyncLocalStorage<Budget>();

/** Give everything inside `fn` one shared cache-operation budget. */
export function withRangeCache<T>(fn: () => Promise<T>): Promise<T> {
  return budgets.run({ left: OPS_PER_REQUEST }, fn);
}

/** Spend `n` operations, or report that there is nothing left to spend. */
function afford(n: number): boolean {
  const budget = budgets.getStore();
  if (!budget) return false; // outside a request: don't touch the shared cache
  if (budget.left < n) return false;
  budget.left -= n;
  return true;
}

/** Test-only: how much of this request's budget is left. */
export function budgetLeft(): number | null {
  return budgets.getStore()?.left ?? null;
}

export interface RangeStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultStore(): RangeStore | null {
  const api = (globalThis as { caches?: { default?: RangeStore } }).caches;
  return api?.default ?? null;
}

/**
 * A cache key for one byte range. The host is not resolved and never reached —
 * the Cache API only uses this as a name.
 */
export function rangeKey(key: string, offset: number, length: number): string {
  return `https://range.reearth-terrain.internal/${encodeURIComponent(key)}?o=${offset}&l=${length}`;
}

/**
 * Read a byte range through the colo's cache, falling back to `read` on a miss
 * and storing what comes back.
 *
 * `read` is still called on every miss and on every request past its budget,
 * so a caller gets the same bytes either way; the only difference is whether
 * R2 was asked.
 */
export async function cachedRange(
  key: string,
  offset: number,
  length: number,
  read: () => Promise<ArrayBuffer>,
  store: RangeStore | null = defaultStore(),
): Promise<ArrayBuffer> {
  if (!store || !afford(2)) return read();

  const request = new Request(rangeKey(key, offset, length));
  try {
    const hit = await store.match(request);
    if (hit) return await hit.arrayBuffer();
  } catch {
    // A cache that cannot be read is not a reason to fail the request.
  }

  const bytes = await read();
  try {
    await store.put(
      request,
      new Response(bytes.slice(0), {
        headers: {
          "Cache-Control": `public, max-age=${TTL_SECONDS}`,
          "Content-Type": "application/octet-stream",
        },
      }),
    );
  } catch {
    // Storing is best effort; the bytes are already in hand.
  }
  return bytes;
}

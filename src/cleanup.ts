// Stale L2 cache cleanup.
//
// `cachedTile` writes objects under
//   cache/terrain/{tileset}/v{version}/{encoding}/{dataType}/{z}/{x}/{y}.{format}
// (see src/cache.ts buildR2Key). Bumping `Tileset.version` rotates the prefix
// so new requests miss the old data, but the previous generation's bytes are
// left behind in R2. This module sweeps them out from a Cron Trigger.
//
// Strategy:
//   1. Build the set of "live" version prefixes from the in-memory TILESETS
//      registry (`cache/terrain/{name}/v{version}/`).
//   2. Walk `cache/terrain/` with delimiter='/' to find tileset directories,
//      then each tileset with delimiter='/' to find v{N}/ prefixes.
//   3. Any v{N}/ — or any whole tileset directory whose name no longer exists
//      in TILESETS — that isn't in the live set becomes stale. We list its
//      contents and call `bucket.delete([...])` in batches of 1000.
//   4. Stop when `deleted >= maxDeletes` and return `truncated: true`. No
//      cursor is persisted: the next invocation re-lists and picks up the
//      remaining keys naturally.
//
// Subrequest budget per invocation, worst case:
//   - 1 top-level list + 1 list per tileset directory
//   - per stale prefix: ceil(keys/1000) * (1 list + 1 delete batch)
// With maxDeletes=5000 that caps at roughly 5 list+5 delete batches per
// stale prefix => well under the Workers Paid limit of 1000 subrequests per
// Cron invocation. Recommended `maxDeletes` by plan:
//   - Workers Free: not supported (50 subrequests cap; raise to Paid).
//   - Workers Paid (default): 5000 — leaves headroom for retries.
//   - Workers Unbound / higher subrequest budgets: 20000+ is fine.

const CACHE_ROOT = "cache/terrain/";
const DELETE_BATCH = 1000;
const LIST_PAGE = 1000;

export interface CleanupTileset {
  name: string;
  version: string;
}

export interface CleanupOptions {
  /** Hard cap on keys deleted in a single invocation. */
  maxDeletes?: number;
  /** Override the R2 key root. Defaults to `cache/terrain/`. */
  prefix?: string;
  /** When true, report what would be deleted without actually deleting. */
  dryRun?: boolean;
}

export interface CleanupResult {
  /** Live `{name}/v{version}/` segments kept this run. */
  liveVersions: string[];
  /** Stale prefixes that were targeted (full R2 prefix). */
  staleVersionPrefixes: string[];
  /** Total keys deleted across all stale prefixes. */
  deleted: number;
  /** True if maxDeletes was hit and there are likely more keys to remove. */
  truncated: boolean;
  /** True when dryRun was requested — `deleted` then reports the *would-delete* count. */
  dryRun: boolean;
}

export async function runCleanup(
  bucket: R2Bucket,
  tilesets: Record<string, CleanupTileset>,
  opts: CleanupOptions = {},
): Promise<CleanupResult> {
  const root = opts.prefix ?? CACHE_ROOT;
  const maxDeletes = opts.maxDeletes ?? 5000;
  const dryRun = opts.dryRun ?? false;

  const liveVersions = Object.values(tilesets).map((t) => `${t.name}/v${t.version}/`);
  const liveSet = new Set(liveVersions);
  const liveTilesets = new Set(Object.values(tilesets).map((t) => `${t.name}/`));

  console.log("cleanup: start", { root, maxDeletes, dryRun, liveVersions });

  const stalePrefixes = await collectStalePrefixes(bucket, root, liveSet, liveTilesets);
  console.log("cleanup: stale prefixes discovered", {
    count: stalePrefixes.length,
    prefixes: stalePrefixes,
  });

  let deleted = 0;
  let truncated = false;
  for (const prefix of stalePrefixes) {
    if (deleted >= maxDeletes) {
      truncated = true;
      console.log("cleanup: budget exhausted before draining all prefixes", {
        deleted,
        maxDeletes,
      });
      break;
    }
    const r = await deletePrefix(bucket, prefix, maxDeletes - deleted, dryRun);
    deleted += r.deleted;
    console.log("cleanup: prefix swept", {
      prefix,
      deletedThisPrefix: r.deleted,
      totalDeleted: deleted,
      truncated: r.truncated,
    });
    if (r.truncated) {
      truncated = true;
      break;
    }
  }

  const result: CleanupResult = {
    liveVersions,
    staleVersionPrefixes: stalePrefixes,
    deleted,
    truncated,
    dryRun,
  };
  console.log("cleanup: done", result);
  return result;
}

/**
 * Two-level walk of `root` to enumerate stale `{root}{tileset}/v{N}/`
 * prefixes. A tileset directory whose name is absent from `liveTilesets`
 * is wholesale stale — we return the directory itself rather than drilling
 * into its versions, so it gets swept clean.
 */
async function collectStalePrefixes(
  bucket: R2Bucket,
  root: string,
  liveVersions: Set<string>,
  liveTilesets: Set<string>,
): Promise<string[]> {
  const stale: string[] = [];

  const tilesetDirs = await listDelimited(bucket, root);
  for (const dir of tilesetDirs) {
    // `dir` is like "cache/terrain/mapterhorn-egm08/"
    const tail = dir.slice(root.length); // "mapterhorn-egm08/"
    if (!liveTilesets.has(tail)) {
      // Whole tileset is unknown — drop everything under it.
      stale.push(dir);
      continue;
    }
    const versionDirs = await listDelimited(bucket, dir);
    for (const v of versionDirs) {
      const versionTail = v.slice(root.length); // "mapterhorn-egm08/v3/"
      if (!liveVersions.has(versionTail)) {
        stale.push(v);
      } else {
        console.log("cleanup: keep live version", { prefix: v });
      }
    }
  }

  return stale;
}

async function listDelimited(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await bucket.list({
      prefix,
      delimiter: "/",
      cursor,
      limit: LIST_PAGE,
    });
    for (const p of res.delimitedPrefixes ?? []) out.push(p);
    if (!res.truncated) break;
    cursor = res.cursor;
    if (!cursor) break;
  }
  return out;
}

async function deletePrefix(
  bucket: R2Bucket,
  prefix: string,
  budget: number,
  dryRun: boolean,
): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0;
  let cursor: string | undefined;
  for (;;) {
    if (deleted >= budget) return { deleted, truncated: true };
    const remaining = budget - deleted;
    const res = await bucket.list({
      prefix,
      cursor,
      limit: Math.min(LIST_PAGE, remaining),
    });
    const keys = res.objects.map((o) => o.key);
    if (keys.length === 0) {
      if (!res.truncated) return { deleted, truncated: false };
      cursor = res.cursor;
      if (!cursor) return { deleted, truncated: false };
      continue;
    }
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      if (!dryRun) await bucket.delete(batch);
      deleted += batch.length;
      console.log(dryRun ? "cleanup: dryRun batch" : "cleanup: delete batch", {
        prefix,
        batchSize: batch.length,
        deletedSoFar: deleted,
        first: batch[0],
        last: batch[batch.length - 1],
      });
    }
    if (!res.truncated) return { deleted, truncated: false };
    cursor = res.cursor;
    if (!cursor) return { deleted, truncated: false };
  }
}

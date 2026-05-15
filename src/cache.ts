// Two-layer cache for generated tiles, plus ETag / If-None-Match support.
//
// L1: Cache API (Cloudflare edge cache). Keyed on the request URL after
//     normalization, so the default-tileset path and the explicit
//     tileset path don't produce duplicate entries.
// L2: an R2 bucket bound as CACHE. Object key includes the tileset name
//     and version, so a `version` bump on a Tileset is sufficient to
//     invalidate the entire prefix without any explicit deletion step
//     (we expect an R2 lifecycle rule to age old entries out).
//
// Per-tile freshness (optional): for sources where upstream rebuilds are
// regional rather than global (e.g., Mapterhorn), the caller can pass a
// `freshness` probe. On an L2 hit older than the probe's TTL we HEAD the
// upstream and compare its `Last-Modified` to the R2 object's `uploaded`
// time — newer upstream means the cached tile is stale and gets rebuilt.
// This is finer-grained than a `version` bump (which invalidates the
// entire prefix), so a regional rebuild only invalidates the tiles that
// actually changed. The L1 entry's internal Cache-Control is clamped to
// the same TTL so edge entries cannot outlive the freshness window —
// clients still see the long, version-pinned max-age on the way out.
//
// ETag is a weak validator computed from the tileset version + tile
// coordinates. It's stable across regenerations of the same tile and
// changes only when the tileset version bumps. If-None-Match short-
// circuits before any cache lookup or generation work, which is the
// cheapest possible path for repeat clients.
//
// Cache-Control intentionally omits `immutable` because the URL is not
// version-pinned; clients re-validate via ETag on max-age expiry.

export interface TileCacheParams {
  tileset: string;
  version: string;
  encoding: string;
  dataType: string;
  z: number;
  x: number;
  y: number;
  format: string;
  /** Used to seed Content-Type if R2 metadata is missing on an L2 hit. */
  fallbackContentType?: string;
  /**
   * Optional per-tile freshness probe. When present, an L2 hit that's older
   * than `ttlMs` is validated against the upstream by comparing
   * `check()` (the upstream `Last-Modified`) to the R2 object's `uploaded`
   * timestamp. If the upstream is newer, the entry is treated as a miss
   * and regenerated. The L1 entry's internal TTL is also clamped to
   * `ttlMs` so edge hits cannot outlive the freshness window.
   */
  freshness?: FreshnessProbe;
}

export interface FreshnessProbe {
  /**
   * Return the upstream's `Last-Modified` timestamp for this tile, or null
   * when the upstream has no opinion (no header, or 404).
   */
  check: () => Promise<Date | null>;
  /** How long an L2 entry is trusted before re-validating against upstream. */
  ttlMs: number;
}

export interface GeneratedTile {
  bytes: Uint8Array;
  contentType: string;
  /**
   * Optional Content-Encoding declaration (e.g. "gzip") for payloads that
   * are already in a transfer-compressed form. Cesium's quantized-mesh
   * pipeline needs this set when we serve gzip-compressed .terrain bytes
   * so the browser auto-decompresses before handing them off.
   */
  contentEncoding?: string;
}

const CACHE_CONTROL = "public, max-age=2592000";

export async function cachedTile(
  req: Request,
  ctx: ExecutionContext,
  bucket: R2Bucket | undefined,
  params: TileCacheParams,
  generate: () => Promise<GeneratedTile>,
  /** When true, skip L1/L2 lookups + writes and always regenerate. */
  disable = false,
): Promise<Response> {
  const etag = await tileEtag(params);

  // If-None-Match short-circuit. Cheapest path: no cache lookup, no work.
  if (!disable && matchesIfNoneMatch(req.headers.get("if-none-match"), etag)) {
    logCache("INM", "hit", params);
    return notModified(etag, params);
  }

  if (disable) {
    const { bytes, contentType, contentEncoding } = await generate();
    return buildResponse(bytes, contentType, "BYPASS", etag, params, contentEncoding);
  }

  const cacheKey = buildCacheKey(req, params);
  const r2Key = buildR2Key(params);
  const cache = caches.default;

  // L1: edge cache.
  const l1Hit = await cache.match(cacheKey);
  logCache("L1", l1Hit ? "hit" : "miss", params);
  if (l1Hit) return decorate(l1Hit, "L1", etag, params);

  // L2: R2.
  if (bucket) {
    const obj = await bucket.get(r2Key);
    if (obj) {
      const fresh = await isStillFresh(obj, params.freshness);
      if (fresh) {
        logCache("L2", "hit", params);
        const body = await obj.arrayBuffer();
        const contentType =
          obj.httpMetadata?.contentType
          ?? params.fallbackContentType
          ?? contentTypeFor(params.format);
        const contentEncoding = obj.httpMetadata?.contentEncoding;
        const resp = buildResponse(body, contentType, "L2", etag, params, contentEncoding);
        ctx.waitUntil(cache.put(cacheKey, buildL1Internal(body, contentType, params, contentEncoding)));
        return resp;
      }
      logCache("L2", "stale", params);
      // Upstream is newer than this cached entry — fall through to regenerate.
    } else {
      logCache("L2", "miss", params);
    }
  }

  // L3: generate.
  logCache("gen", "miss", params);
  const { bytes, contentType, contentEncoding } = await generate();
  const resp = buildResponse(bytes, contentType, "MISS", etag, params, contentEncoding);
  const writes: Promise<unknown>[] = [
    cache.put(cacheKey, buildL1Internal(bytes, contentType, params, contentEncoding)),
  ];
  if (bucket) {
    const httpMetadata: R2HTTPMetadata = { contentType };
    if (contentEncoding) httpMetadata.contentEncoding = contentEncoding;
    writes.push(bucket.put(r2Key, bytes, { httpMetadata }));
  }
  ctx.waitUntil(Promise.all(writes));
  return resp;
}

/**
 * Decide whether an R2-cached entry can be served without regenerating.
 *
 * Without a freshness probe, the static version prefix is the only
 * invalidation knob, and any L2 hit is considered fresh.
 *
 * With a probe, we trust the entry for `ttlMs` after its R2 `uploaded`
 * time, then HEAD the upstream and compare `Last-Modified` to `uploaded`:
 * a newer upstream means the cached tile was generated before the source
 * data changed and must be rebuilt. Existing entries from before the
 * freshness probe was introduced are handled transparently — they have an
 * `uploaded` time, so the same comparison works without any custom R2
 * metadata.
 */
async function isStillFresh(
  obj: R2ObjectBody,
  probe: FreshnessProbe | undefined,
): Promise<boolean> {
  if (!probe) return true;
  const age = Date.now() - obj.uploaded.getTime();
  if (age <= probe.ttlMs) return true;
  const upstreamLm = await probe.check();
  if (!upstreamLm) return true;
  return upstreamLm.getTime() <= obj.uploaded.getTime();
}

/**
 * Build the response stashed in the L1 (edge) cache. Identical bytes and
 * headers to the client response — except for `Cache-Control`, which is
 * shortened to the freshness TTL when a probe is configured. That keeps
 * the edge from outliving the L2 validity window: the L1 entry expires
 * around the same time we'd next re-probe upstream, so a Mapterhorn
 * rebuild is reflected at the edge within roughly one TTL period.
 */
function buildL1Internal(
  body: BodyInit,
  contentType: string,
  params: TileCacheParams,
  contentEncoding: string | undefined,
): Response {
  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": internalCacheControl(params),
  };
  if (contentEncoding) headers["content-encoding"] = contentEncoding;
  return new Response(body, { headers });
}

function internalCacheControl(params: TileCacheParams): string {
  if (!params.freshness) return CACHE_CONTROL;
  const seconds = Math.max(1, Math.floor(params.freshness.ttlMs / 1000));
  return `public, max-age=${seconds}`;
}

function buildCacheKey(req: Request, params: TileCacheParams): Request {
  // Include `version` so a Tileset bump rotates the L1 (edge) cache the same
  // way it rotates L2 (R2). Without it, edge entries from the previous
  // version keep serving (URL is the only L1 key), defeating the bump.
  // The path is internal to the Worker — Cesium clients still request the
  // version-less public URL.
  const url = new URL(req.url);
  url.pathname = `/${params.tileset}/v${params.version}/${params.encoding}/${params.dataType}/${params.z}/${params.x}/${params.y}.${params.format}`;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

function buildR2Key(params: TileCacheParams): string {
  return `cache/terrain/${params.tileset}/v${params.version}/${params.encoding}/${params.dataType}/${params.z}/${params.x}/${params.y}.${params.format}`;
}

async function tileEtag(p: TileCacheParams): Promise<string> {
  // Weak ETag: identifies the *content* a tile coord should produce, not
  // a byte-exact response. Encoders are deterministic, but cache layers
  // may rebuild payloads on the way back; weak comparison is the safe
  // semantic.
  const seed = `${p.tileset}@${p.version}:${p.encoding}:${p.dataType}:${p.z}:${p.x}:${p.y}.${p.format}`;
  return `W/"${await sha256Hex(seed, 8)}"`;
}

export async function bodyEtag(body: string): Promise<string> {
  // Strong ETag: byte-exact body. Suitable for tilejson / catalog JSON.
  return `"${await sha256Hex(body, 8)}"`;
}

async function sha256Hex(input: string, byteLen: number): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const view = new Uint8Array(buf, 0, byteLen);
  let hex = "";
  for (const b of view) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function matchesIfNoneMatch(headerValue: string | null, etag: string): boolean {
  if (!headerValue) return false;
  if (headerValue.trim() === "*") return true;
  // Per RFC 7232 §3.2, If-None-Match uses weak comparison, so we treat
  //   W/"abc" and "abc" as equal.
  const normalized = stripWeak(etag);
  return headerValue.split(",").some((token) => stripWeak(token.trim()) === normalized);
}

function stripWeak(v: string): string {
  return v.startsWith("W/") ? v.slice(2) : v;
}

function buildResponse(
  body: BodyInit,
  contentType: string,
  cacheStatus: "L1" | "L2" | "MISS" | "BYPASS",
  etag: string,
  params: TileCacheParams,
  contentEncoding?: string,
): Response {
  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": CACHE_CONTROL,
    etag,
    "x-cache": cacheStatus,
    "x-tileset": `${params.tileset}@${params.version}`,
  };
  if (contentEncoding) headers["content-encoding"] = contentEncoding;
  return new Response(body, { headers });
}

function decorate(
  resp: Response,
  cacheStatus: "L1",
  etag: string,
  params: TileCacheParams,
): Response {
  const headers = new Headers(resp.headers);
  headers.set("x-cache", cacheStatus);
  headers.set("x-tileset", `${params.tileset}@${params.version}`);
  headers.set("etag", etag);
  // The stored response carries the short internal Cache-Control (so the
  // edge entry expires around the freshness window). Clients should still
  // see the long, version-pinned max-age — overwrite on the way out.
  headers.set("cache-control", CACHE_CONTROL);
  return new Response(resp.body, { status: resp.status, headers });
}

function notModified(etag: string, params: TileCacheParams): Response {
  return new Response(null, {
    status: 304,
    headers: {
      etag,
      "cache-control": CACHE_CONTROL,
      "x-cache": "304",
      "x-tileset": `${params.tileset}@${params.version}`,
    },
  });
}

function logCache(
  layer: "INM" | "L1" | "L2" | "gen",
  outcome: "hit" | "miss" | "stale",
  params: TileCacheParams,
): void {
  console.log(JSON.stringify({
    event: "cache_check",
    layer,
    outcome,
    tileset: params.tileset,
    version: params.version,
    encoding: params.encoding,
    dataType: params.dataType,
    z: params.z,
    x: params.x,
    y: params.y,
  }));
}

function contentTypeFor(format: string): string {
  switch (format) {
    case "webp": return "image/webp";
    case "png": return "image/png";
    case "terrain": return "application/vnd.quantized-mesh";
    default: return "application/octet-stream";
  }
}

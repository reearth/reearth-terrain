# Contributing

Internal notes for hacking on reearth-terrain. End-user docs (endpoints,
quick start, data sources) live in [`README.md`](./README.md).

## Layout

- `src/` — TypeScript Worker. Routing, I/O, cache, response shaping.
- `crates/` — Rust crates compiled to WebAssembly. Pure numeric work.
- `scripts/` — Local dev helpers (data fetch / upload, wasm build).

The Worker entry point lives at the top of `src/`. Read it first — every
route handler is one short function, so the request lifecycle is
discoverable from there without a separate module map.

### TS vs WASM boundary

The split is by *capability*, not by topic. New code lands on the TS
side unless it falls cleanly into the WASM bucket.

- **TypeScript** owns anything that touches a runtime binding or an
  external resource: HTTP routing, R2 / Cache / KV / `fetch`, response
  building, byte-range planning against remote GeoTIFFs, MVT decoding,
  HTTP-level caching and ETag arithmetic.
- **WASM (Rust)** is pure numeric functions only — pixel encodings,
  image (en|de)coding, mesh simplification, quantized-mesh
  serialization. It must not import any runtime binding; the TS side
  feeds it bytes and reads bytes back.

## Tilesets

A tileset declares a DEM source, a geoid R2 key, an optional watermask
provider, and an attribution list. The default is `mapterhorn-egm08`,
defined in `src/tilesets.ts`. Adding a new tileset is one struct literal —
the routing automatically picks it up.

`tileset.version` exists to invalidate caches without touching URLs. Bump
it whenever the underlying inputs change in a way clients shouldn't keep
stale entries for (e.g. swapping the encoder, changing the blending
formula). `tileset.geoidVersion` is the same knob scoped to the geoid
input — bump it in isolation when only the geoid COG has changed and
DEM-only entries should survive. Both fold into the cache prefix:
`v{version}` or `v{version}-g{geoidVersion}`.

## Caching contract

Three orthogonal invalidation mechanisms cooperate, each tuned to a
different rate of change:

1. **Static version bumps** (`tileset.version`, `tileset.geoidVersion`)
   for code- or input-changes the operator controls. Flipping the value
   rotates the cache-key prefix — every existing entry under the old
   prefix becomes unreachable in one shot. Use for encoder swaps, blend
   formula changes, geoid model swaps. The Cron Trigger in `wrangler.toml`
   sweeps the orphaned R2 prefix daily (see `src/cleanup.ts`).
2. **Watermask source date** (Protomaps daily build), HEAD-probed at
   request time with a 1 h in-memory cache (`src/protomaps.ts`). The
   resolved `YYYYMMDD` is folded into the *encoding* segment of the
   cache key, so only watermask-bearing entries flip when a new build
   ships.
3. **Per-tile DEM freshness** (Mapterhorn), HEAD-probed against the
   upstream tile when an L2 entry is older than 6 h
   (`src/cache.ts` freshness probe + `MapterhornSource.freshness`).
   Mapterhorn rebuilds are regional, so we compare the upstream
   `Last-Modified` to the R2 object's `uploaded` time and invalidate
   only the tiles whose source actually changed — no global rotation
   even after a substantial Mapterhorn release.

### Storage layers

- **L1**: Cloudflare Cache API, keyed on a path normalized to the
  explicit tileset form so the default-tileset alias shares the same
  entry. The internal Cache-Control max-age is shortened to the
  freshness TTL (6 h) when a probe is configured, so edge entries
  cannot outlive the validity window — clients still see
  `max-age=2592000` on the way out via the response decorator.
- **L2**: an R2 bucket bound as `CACHE`, with key prefix
  `cache/terrain/{tileset}/v{version}[-g{geoidVersion}]/...`.

### ETag

SHA-256-truncated weak validator over
`{tileset}@{version}:{encoding}:{data_type}:{z}:{x}:{y}.{format}`.
The resolved version already encodes the geoid revision; the encoding
segment carries the watermask build date when applicable; so a single
weak ETag captures every invalidation axis. `If-None-Match` short-
circuits before any cache lookup, generation, or freshness probe.

### Cache-Control

- Tiles: `public, max-age=2592000` on the client-facing response.
- JSON (TileJSON / layer.json / `/tilesets`): `max-age=3600`.
- The internal L1 response carries a shorter `max-age` matching the
  freshness TTL when a per-tile probe is active — never returned to
  clients.

### Adding a new invalidation signal

- If the change is operator-driven and global → bump a `version` field.
- If the change is upstream-driven and global → resolve at request
  time and fold into either the cache-key prefix (when the whole
  cached output goes stale) or the encoding segment (when it only
  affects one variant), mirroring the Protomaps daily-build pattern.
- If the change is upstream-driven and per-region → implement
  `DemSource.freshness` (or an analogous per-tile probe) and pass a
  `FreshnessProbe` into `cachedTile`. Compare upstream `Last-Modified`
  against `R2Object.uploaded` and rely on the probe TTL for cost
  control.

## Debug endpoints

Internal-only JSON inspection routes. Handy when iterating on DEM /
geoid / watermask plumbing.

| Path | Purpose |
|---|---|
| `GET /debug/cog?key=...` | COG metadata via `geotiff.js` |
| `GET /debug/tile?key=...&z=&x=&y=` | Raw COG samples for a Web Mercator tile |
| `GET /debug/dem?z=&x=&y=&tileset=` | Mapterhorn DEM samples + stats |
| `GET /debug/ellipsoid?type=&z=&x=&y=&tileset=` | Blended grid + stats |
| `GET /debug/watermask?z=&x=&y=&tileset=` | Resolved PMTiles source + classification |

## Development

### Prerequisites

- Node.js 22+ (wrangler 4 requirement)
- Rust stable (`rustup target add wasm32-unknown-unknown`)
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) 0.14+
- [`binaryen`](https://github.com/WebAssembly/binaryen) — provides `wasm-opt`
  for release size optimization. Skipped automatically when missing.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
brew install binaryen        # Linux: distro package or upstream release
npm install
```

> wasm-pack ships an old wasm-opt that rejects modern rustc output, so
> `scripts/build-wasm.mjs` runs the system wasm-opt from `PATH` instead.

### Prepare source data

```bash
npm run data:egm08       # downloads the ~80 MB EGM2008 COG from cdn.proj.org into data/
npm run data:upload      # pushes to the local Miniflare R2 bucket
```

`FORCE=1 npm run data:egm08` re-downloads.

### Run locally

```bash
npm run dev
# then open http://localhost:8787/         (landing page)
#  or open http://localhost:8787/viewer    (CesiumJS tile inspector)
```

### Tasks

| Script | Purpose |
|---|---|
| `npm run dev` | wrangler dev on :8787 |
| `npm run build:wasm` | wasm-pack build + glue patch + wasm-opt |
| `npm run build` | wasm + wrangler dry-run into `dist/` |
| `npm run deploy` | wasm + wrangler deploy |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run data:egm08` | Fetch the geoid COG |
| `npm run data:upload` | Upload data/*.tif to local R2 |

## Deployment

Pushes to `main` trigger `.github/workflows/ci.yml`. After the build and
cargo-test jobs pass, the `deploy` job runs `wrangler deploy` against the
account pinned in `wrangler.toml`.

Required GitHub secret (set on the `production` environment):

- `CLOUDFLARE_API_TOKEN` — token with **Account › Workers Scripts: Edit**,
  **Account › Workers R2 Storage: Edit**, **Account › Account Settings:
  Read**, and **Zone › Workers Routes: Edit** on the `reearth.land` zone.

`account_id`, the custom domain route, and the R2 bucket name are committed
to `wrangler.toml`, so the workflow doesn't need to inject them. Geoid
source data lives in R2 already — upload new inputs out-of-band with
`wrangler r2 object put`, not from CI.

## Gotchas

### Cesium signals extensions via `Accept`, not the URL

`CesiumTerrainProvider` does **not** append `?extensions=octvertexnormals`
to tile URLs even though that's what its own `layer.json` advertises.
Instead it sets the request header

```
Accept: application/vnd.quantized-mesh;extensions=octvertexnormals-watermask, ...
```

If the Worker only reads the query string, the same URL will alternate
between "normals" and "no normals" depending on the request — and
worse, both variants share a cache key, so whichever one warms the
cache wins and clients see arbitrary mismatches. The handler reads the
`extensions` parameter out of the `Accept` media-type *and* the query
string, unions them, and folds the result into the cache key. Keep
both paths in sync when adding a new extension.

### Don't set `Content-Encoding` on binary tiles

The Worker hands quantized-mesh and other binary tiles to workerd *raw*
and lets the runtime compress for transit. Setting `Content-Encoding`
ourselves caused workerd to double-frame the body, which Cesium's parser
then mis-decoded — see the Cesium viewer commit message for the full
forensic.

### Horizon occlusion point must be computed per-vertex

The naive formula — `mag + scaled_radius` along the bounding-sphere
center direction — yields a magnitude around 2.4 for level-0
hemisphere tiles. Cesium's `isScaledSpacePointVisible` then treats
the tile as below the horizon for any camera whose ECEF Y component
is small, and culls the entire subtree. Symptoms in practice: large
regions of the eastern hemisphere (Geneva, Amsterdam, …) silently
fail to render even though the mesh bytes are correct.

Use Cesium's `EllipsoidalOccluder` algorithm against the actual
mesh vertices. For small tiles it produces tight finite magnitudes;
for the level-0 hemisphere tiles the formula diverges, matching
the very large occlusion points used by reference implementations
and ensuring those tiles always pass visibility. A "simpler"
replacement here is almost certainly wrong.

### Mapterhorn coverage is incomplete at z ≥ 13 — walk up on miss

Mapterhorn doesn't publish high-zoom tiles for every region (Andes,
Himalaya, parts of the Americas, high-altitude lakes, …). Treating a
404 as "elevation = 0" produces flat geoid-only patches next to
neighbouring tiles that *do* have data, which renders as multi-km
cliffs at the boundary (e.g. ~3.8 km wall around Titicaca, Everest,
Death Valley).

Both sampling paths must walk up the WM zoom on miss and crop the
descendant region from the first ancestor that returns data — the
cesium-mesh path retries the whole tile set; the raster-dem path
drops to a parent and resamples the corresponding sub-rectangle.
Verify against /debug/ellipsoid for the regions above before
changing the sampling code.

### Watermask classification runs on orthometric DEM, not ellipsoid heights

The Quantized Mesh water-mask spec has no per-tile threshold — clients
assume the default "≤ 0 m = water" rule. If classification reads the
ellipsoid-height grid that the mesh encoder consumes, the geoid offset
(positive over most of the globe) shifts coastline-level samples above
zero and they get classified as land. Symptoms are subtle: oceans
still look right; coastlines and low-lying water (polders, salt flats)
break.

Keep the watermask path anchored on the orthometric DEM samples, even
though the encoder receives ellipsoid heights. The encoder only sees
the resulting mask bytes, so the API stays neutral about which grid
the classification ran against — the invariant lives entirely in the
TS-side pipeline.

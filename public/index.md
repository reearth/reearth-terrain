# Re:Earth Terrain

**Open terrain tiles for 3D globes, served from the edge. CesiumJS & MapLibre, no auth, no key.**

Production endpoint: <https://terrain.reearth.land>

> This is the AI-friendly Markdown rendering of the landing page at <https://terrain.reearth.land/>. The same URL returns HTML by default, or this file when the `Accept` request header prefers `text/markdown`. The standalone file lives at <https://terrain.reearth.land/index.md>, and an llms.txt index is at <https://terrain.reearth.land/llms.txt>.

## One URL. Your renderer picks up the rest.

The service publishes both Cesium `layer.json` and TileJSON, so Cesium and MapLibre each configure themselves from a single URL. No tokens, no signup — just the path.

### CesiumJS — quantized-mesh-1.0

Point `CesiumTerrainProvider.fromUrl` at the endpoint. Extensions like vertex normals and the water mask are advertised in `layer.json` and negotiated automatically.

```js
const terrain = await Cesium.CesiumTerrainProvider.fromUrl(
  "https://terrain.reearth.land/cesium-mesh/ellipsoid",
  { requestVertexNormals: true, requestWaterMask: true }
);
const viewer = new Cesium.Viewer("cesium", { terrainProvider: terrain });
```

### MapLibre GL JS — Mapbox Terrain-RGB

Reach for this when you specifically need ellipsoidal heights. For ordinary 2.5D hillshade, [Mapterhorn](https://mapterhorn.com) is the better default.

```js
map.addSource("terrain", {
  type: "raster-dem",
  url:  "https://terrain.reearth.land/mapbox/ellipsoid/tilejson.json",
});
map.setTerrain({ source: "terrain" });
```

### MapLibre GL JS — Terrarium

Same content, different pixel encoding. Use this when your toolchain already speaks Terrarium (Mapzen, AWS Open Terrain Tiles, deck.gl, …).

```js
map.addSource("terrain", {
  type: "raster-dem",
  url:  "https://terrain.reearth.land/terrarium/ellipsoid/tilejson.json",
  encoding: "terrarium",
});
map.setTerrain({ source: "terrain" });
```

## 3D Earth needs *ellipsoidal* heights.

Drape regular elevation tiles over a Cesium globe and the terrain lands tens of meters off where the renderer thinks the planet's surface is. Mt. Fuji's 3,776 m above sea level sits about 37 m below the point the globe is actually drawing — because sea-level heights were never measured against the smooth WGS84 ellipsoid that 3D Earth uses. They were measured against the lumpy shape of mean sea level: the **geoid**.

NGA's EGM2008 publishes the offset between geoid and ellipsoid as a grid (−106 m to +85 m worldwide). Add it to a sea-level height and you get the **ellipsoidal height** a 3D globe needs.

Re:Earth Terrain does that per request, in whatever wire format your renderer expects — so ellipsoidal-height datasets like Japan's [PLATEAU](https://www.mlit.go.jp/plateau/) 3D city models drop in with buildings already sitting on the ground. Three knobs at the URL, all from one upstream DEM and geoid.

The relationship is **h = H + N**, where:

- **h** — ellipsoidal height (what a 3D globe wants)
- **H** — orthometric height (height above mean sea level, what most DEMs publish)
- **N** — geoid undulation (the offset between geoid and ellipsoid at a point)

### 01 — Wire formats

`quantized-mesh-1.0` ships TMS-Geographic meshes for Cesium, with optional vertex normals and a 256×256 water mask. Raster (`mapbox` or `terrarium` pixel encoding) packs heights into PNG/WebP tiles for MapLibre, Mapbox GL, and anything else that already speaks raster-DEM.

### 02 — Vertical datums

Pick the surface heights are measured against: `ellipsoid` for 3D globes and anything fed by GNSS; `elevation` for hiking maps and sea-level overlays. Same DEM, same geoid — the path decides how they're blended.

### 03 — Standalone geoid

The `geoid` data type returns the EGM2008 undulation by itself — handy for client-side conversion or visualizing the surface directly.

```
/mapbox/geoid/tilejson.json
```

## Endpoints

All paths share the shape `/{tileset}/{encoding}/{data_type}/...`.

`{tileset}` defaults to `mapterhorn-egm08` and may be omitted entirely (`/cesium-mesh/ellipsoid/layer.json` is equivalent to `/mapterhorn-egm08/cesium-mesh/ellipsoid/layer.json`).

`{encoding}` selects the output format and dictates the file extension:

| `{encoding}` | Output | Extension | Typical consumer |
|---|---|---|---|
| `cesium-mesh` | quantized-mesh-1.0 (TMS Geographic) | `.terrain` | CesiumJS |
| `mapbox` | Mapbox Terrain-RGB (Web Mercator XYZ) | `.webp` / `.png` | MapLibre, Mapbox GL |
| `terrarium` | Mapzen Terrarium (Web Mercator XYZ) | `.webp` / `.png` | MapLibre, deck.gl |

`{data_type}` selects the vertical reference of the elevation values:

| `{data_type}` | Meaning | Use it for |
|---|---|---|
| `ellipsoid` | DEM + geoid undulation, i.e. height above the WGS84 ellipsoid | CesiumJS globe terrain (`cesium-mesh`) |
| `elevation` | Orthometric height (meters above mean sea level) from the DEM | MapLibre / MapboxGL, contour generation, anything assuming MSL |
| `geoid` | EGM2008 geoid undulation only | Coordinate conversions, geoid visualization |

### Tile and metadata routes

| Path | Purpose |
|---|---|
| `GET /{tileset}/cesium-mesh/{data_type}/{z}/{x}/{y}.terrain` | quantized-mesh tile |
| `GET /{tileset}/cesium-mesh/{data_type}/layer.json` | Cesium `layer.json` |
| `GET /{tileset}/{mapbox\|terrarium}/{data_type}/{z}/{x}/{y}.{webp\|png}` | raster terrain tile |
| `GET /{tileset}/{mapbox\|terrarium}/{data_type}/tilejson.json` | TileJSON 3.0.0 |
| `GET /{tileset}/watermask/{z}/{x}/{y}.{webp\|png}` | water mask raster tile (Web Mercator XYZ) |
| `GET /{tileset}/watermask-tms/{z}/{x}/{y}.{webp\|png}` | water mask raster tile (TMS Geographic, Cesium-compatible) |
| `GET /{tileset}/{watermask\|watermask-tms}/tilejson.json` | TileJSON 3.0.0 for the watermask raster |

The watermask raster is a 256×256 RGBA tile: water is opaque black (`#000000`, α=255), land is fully transparent. Drop it into MapLibre / Mapbox GL as an overlay and tint with `raster-color` if you want it colored.

### Cesium extensions (mesh only)

`cesium-mesh` requests honor the standard `?extensions=` query that `CesiumTerrainProvider` sends — and `fromUrl` will send it on its own based on the `requestVertexNormals` / `requestWaterMask` flags.

- `?extensions=octvertexnormals` — vertex normals for shading
- `?extensions=watermask` — 256×256 water mask from Protomaps
- `?extensions=octvertexnormals-watermask` — both
- Shorthands: `?normals=true`, `?watermask=true`

### Catalog and metadata

| Path | Purpose |
|---|---|
| `GET /tilesets` | List of registered tilesets with attribution |
| `GET /` | Landing page (HTML; Markdown via `Accept: text/markdown`) |
| `GET /index.md` | This Markdown landing page |
| `GET /llms.txt` | llms.txt index for AI clients |
| `GET /viewer` | Built-in CesiumJS viewer (append `?demo` for chrome-less orbit) |
| `GET /health` | Liveness probe |

## Three open datasets, stitched live.

Most bytes are served from our own R2 mirror. EGM2008 ships as a COG in R2 from day one, the Protomaps water mask is snapshotted monthly into R2, and Mapterhorn planet tiles (z ≤ 12) are mirrored to R2 — higher zooms are mirrored progressively, with any not-yet-mirrored areas falling back to the upstream Mapterhorn endpoint over HTTPS. The attributions below are injected into TileJSON and Cesium `layer.json` so your clients display them automatically.

| Source | Role | License |
|---|---|---|
| [Mapterhorn](https://mapterhorn.com/) | DEM — terrain heights. Global DEM with sea-level heights. A fused product itself — NASADEM, Copernicus GLO-30 and others are blended upstream. | CC BY 4.0 |
| [EGM2008](https://earth-info.nga.mil/) | Geoid — sea-level ↔ ellipsoid offset. Geoid undulation grid published by the US National Geospatial-Intelligence Agency. Powers the sea-level → ellipsoidal conversion and the standalone geoid data type. | Public domain |
| [Protomaps daily basemap](https://protomaps.com/) | Water mask — OpenStreetMap-derived water polygons that produce the optional 256×256 water mask attached to quantized-mesh tiles. Snapshotted monthly into our own R2 so the mask keeps working when the upstream daily archive rotates out. | ODbL · © OpenStreetMap contributors |

## About this service

**Re:Earth Terrain** is operated by [Eukarya, Inc.](https://eukarya.io) as part of the Re:Earth ecosystem. It started as the terrain backend for [Re:Earth](https://reearth.io), our open-source 3D mapping platform, and we run it openly because the data and tools we build on — OpenStreetMap, Mapterhorn, EGM2008 — are themselves open.

The compute runs on Cloudflare Workers, with R2 holding both the source datasets and a content-addressed tile cache. The project's own code is MIT-licensed and lives [on GitHub](https://github.com/reearth/reearth-terrain).

By design, source datasets are mirrored into R2, but the tiles we serve — quantized-mesh, raster terrain, the water mask attached to a mesh — are assembled on demand from those sources. There is no batch re-tile pipeline and we don't publish pre-rendered tile archives; refreshing a mirror is enough for new data to show up in the next request.

### Operating model

Best-effort uptime, no SLA, no signup, no API key. We may add rate limits without notice if a single client starts dominating traffic — the goal is keeping the service usable for everyone, not gating access.

### Attribution

The code is MIT, but the data licenses ride along with the tile bytes. The runtime ships every required attribution in TileJSON / `layer.json`, so wiring up the service with its defaults is usually enough.

If you're surfacing credits outside that flow, the minimum line is:

```
Re:Earth Terrain · Mapterhorn (CC BY 4.0)
```

Append when the water mask is enabled:

```
Protomaps · © OpenStreetMap contributors (ODbL)
```

### What this isn't

Not a production SaaS with an SLA, and not a guaranteed dataset for safety-critical work. If you need either, host the upstream sources yourself — or reach Eukarya at <info@eukarya.io>.

---

- Viewer: <https://terrain.reearth.land/viewer>
- GitHub: <https://github.com/reearth/reearth-terrain>
- Re:Earth: <https://reearth.io>

© Re:Earth and contributors

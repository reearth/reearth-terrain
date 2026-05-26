[![Re:Earth Terrain — a 3D-rendered red Mt. Fuji rising from elevation tiles](https://terrain.reearth.land/og.jpg)](https://terrain.reearth.land/)

# Re:Earth Terrain - [terrain.reearth.land](https://terrain.reearth.land/)

**Open terrain tiles for 3D globes.** A 3D Earth renderer (Cesium,
three.js, any WebGL globe) draws the planet as a smooth WGS84
ellipsoid, but most DEMs publish heights above mean sea level — which
sit tens of meters off that surface. Re:Earth Terrain blends a global
DEM with the EGM2008 geoid per request so heights land where the
renderer is actually drawing, and ships the result in the formats
CesiumJS and MapLibre already speak: quantized-mesh-1.0, Mapbox
Terrain-RGB, and Mapzen Terrarium.

Underneath: the DEM comes from [Mapterhorn](https://mapterhorn.com/),
the geoid from EGM2008 via PROJ, and the optional water mask from
Protomaps PMTiles. Everything runs on a single Cloudflare Worker with
R2 for source data and tile cache.

Production endpoint: **`https://terrain.reearth.land`** — the root
serves [the landing page](https://terrain.reearth.land/) (overview of
the why and how), and a built-in CesiumJS viewer lives at
[`/viewer`](https://terrain.reearth.land/viewer) (or
`http://localhost:8787/viewer` when running locally).

## Quick start

### CesiumJS (quantized-mesh-1.0)

`cesium-mesh` produces TMS-Geographic quantized-mesh tiles that
`CesiumTerrainProvider` consumes directly. `ellipsoid` is the right
data type for Cesium's globe — heights are referenced to the WGS84
ellipsoid, which is what Cesium expects.

```js
import * as Cesium from "cesium";

const terrain = await Cesium.CesiumTerrainProvider.fromUrl(
  "https://terrain.reearth.land/cesium-mesh/ellipsoid",
  {
    requestVertexNormals: true, // shading
    requestWaterMask: true,     // ocean / lake surfaces
  },
);

const viewer = new Cesium.Viewer("cesium", { terrainProvider: terrain });
viewer.scene.globe.enableLighting = true;
```

`fromUrl` fetches `layer.json` from the same path and discovers the tile
URL template, available zooms, and supported extensions automatically.

### MapLibre GL JS (raster-dem, optional)

For MapLibre, **[Mapterhorn](https://mapterhorn.com) is the recommended
default**: it's a free, global, well-maintained Terrain-RGB tileset and
nothing in this service beats it for ordinary 2.5D hillshade / terrain
rendering.

This service's raster-dem endpoint is worth reaching for in one specific
case: **you need ellipsoidal heights (`ellipsoid`)** — e.g. you're
comparing DEM values against GNSS readings, fusing the basemap with a
Cesium scene that already uses ellipsoidal heights, or running analysis
that expects WGS84 ellipsoid. Mapterhorn ships orthometric heights only.

```js
map.addSource("terrain", {
  type: "raster-dem",
  url: "https://terrain.reearth.land/mapbox/ellipsoid/tilejson.json",
});
map.setTerrain({ source: "terrain" });
// add a `hillshade` layer if you want visible shaded relief
```

Swap `mapbox` for `terrarium` and add `encoding: "terrarium"` to the
source if your toolchain prefers Terrarium-encoded pixels. The TileJSON
endpoint advertises the tile template and zoom range, so one URL is
enough.

## Endpoints

All paths share the shape `/{tileset}/{encoding}/{data_type}/...`.

`{tileset}` defaults to `mapterhorn-egm08` and may be omitted entirely
(`/cesium-mesh/ellipsoid/layer.json` is equivalent to
`/mapterhorn-egm08/cesium-mesh/ellipsoid/layer.json`).

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

### Watermask raster output

`watermask` / `watermask-tms` expose the same Protomaps-derived water polygons that `cesium-mesh?extensions=watermask` attaches to mesh tiles, but as a 256×256 RGBA raster you can drop into any map renderer as an overlay. Water is opaque black (`#000000`, α=255), land is fully transparent — so MapLibre's `raster-opacity` / `raster-color` (or shadow / blend layers on top) can recolor or composite the mask without any extra processing.

```js
map.addSource("water", {
  type: "raster",
  url: "https://terrain.reearth.land/watermask/tilejson.json",
  tileSize: 256,
});
map.addLayer({
  id: "water",
  type: "raster",
  source: "water",
  paint: { "raster-color": "#1f6feb" }, // tint the opaque-black mask
});
```

Use `watermask-tms` when you need the tile coordinates to line up 1:1 with `cesium-mesh` (TMS Geographic). For ordinary 2D MapLibre / Leaflet / Mapbox GL stacks, pick `watermask` (Web Mercator XYZ — the projection Protomaps publishes natively).

### Cesium extensions (mesh only)

`cesium-mesh` requests honor the standard `?extensions=` query that
`CesiumTerrainProvider` sends — and `fromUrl` will send it on its own
based on the `requestVertexNormals` / `requestWaterMask` flags.

- `?extensions=octvertexnormals` — vertex normals for shading
- `?extensions=watermask` — 256x256 water mask from Protomaps
- `?extensions=octvertexnormals-watermask` — both
- Shorthands: `?normals=true`, `?watermask=true`

### Catalog and metadata

| Path | Purpose |
|---|---|
| `GET /tilesets` | List of registered tilesets with attribution |
| `GET /` | Landing page |
| `GET /viewer` | Built-in CesiumJS viewer (append `?demo` for chrome-less orbit) |
| `GET /health` | Liveness probe |

## Data sources

The default `mapterhorn-egm08` tileset pulls from three upstream
services. Mapterhorn DEM tiles and Protomaps water polygons are
fetched at request time over HTTPS (Range GETs, no intermediate
re-hosting); the EGM2008 geoid is small enough that we keep a pre-built
COG in our R2 bucket so the worker can Range-read it without a public
upstream on the hot path. The runtime injects every required
attribution into TileJSON and the Cesium `layer.json`, so for most
clients displaying the source's default credits is enough.

| Source | Role | License / terms |
|---|---|---|
| [Mapterhorn](https://mapterhorn.com/) | Global DEM (orthometric heights). Used directly for `data_type=elevation` and combined with the geoid for `ellipsoid`. Fetched live from `tiles.mapterhorn.com`. | CC BY 4.0 |
| [EGM2008](https://earth-info.nga.mil/) (NGA) | Geoid undulation grid. Drives the orthometric → ellipsoid conversion and powers `data_type=geoid`. Distributed as a 2.5-arcminute COG (`us_nga_egm08_25.tif`) via the [PROJ data CDN](https://cdn.proj.org/) and mirrored into our R2 bucket via [`scripts/fetch-egm08.sh`](./scripts/fetch-egm08.sh). | US government work — public domain, attribution requested |
| [Protomaps daily basemap](https://protomaps.com/) | Source of the OpenStreetMap-derived water polygons that produce `?watermask=true`. Fetched live from `build.protomaps.com`. | ODbL (inherited from OpenStreetMap) |

Mapterhorn is itself a fused product blended from several public DEMs
upstream. We credit Mapterhorn as the single source of record rather
than cherry-picking a subset of its components — see [Mapterhorn's
attribution page](https://mapterhorn.com/) for the full list of
underlying datasets and their licensing. The watermask path additionally
requires the OpenStreetMap attribution because the underlying water
polygons come from OSM.

This project's own code is MIT (see [License](#license)); the licensing
of the underlying *data* above is independent of that and travels with
the tile bytes.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the source layout, the
TS / WASM boundary, the caching contract, debug endpoints, local
development, and deployment notes.

## Ideas / Roadmap

Not committed to, just parked here so we don't forget:

- **heightmap-1.0 compatibility endpoint** — serve Cesium's legacy
  heightmap-1.0 format (65x65 16-bit heightmap) as a fallback for old
  clients that can't speak quantized-mesh.
- **AVIF output** — add `avif` to `{format}`. Better compression than
  WebP, and its lossless mode keeps the zero-error requirement that
  Terrarium / Mapbox RGB encoding needs.
- **R2 mirror for Mapterhorn / Protomaps** — production requests
  currently Range-GET the upstreams (mapterhorn.com, build.protomaps.com)
  directly, so an upstream outage becomes our outage. Mirror the primary
  COGs and the latest PMTiles into our own R2 to cut that dependency.
- **WAF / Rate Limit / Spend Limit** — Cloudflare-side rate limiting plus
  a Workers Spend Limit so a runaway client or a DoS can't blow up the
  bill.
- **Bathymetry (seafloor) support** — current DEMs clamp to 0 m at the
  coastline. Blend in a bathymetric source (e.g. GEBCO) so the
  `elevation` / `ellipsoid` outputs carry below-sea-level values too,
  with a new tileset variant rather than mutating the default.
## License

MIT

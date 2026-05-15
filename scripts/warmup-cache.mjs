#!/usr/bin/env node
// Warm up the Cesium quantized-mesh cache for a set of regions, requesting
// normals + watermask so the cached payloads match what the viewer asks for.
//
// Usage:
//   node scripts/warmup-cache.mjs                 # default regions + zooms
//   BASE=https://... node scripts/warmup-cache.mjs

const BASE = process.env.BASE ?? "https://terrain.reearth.land";
const PATH = "/cesium-mesh/ellipsoid";
const ACCEPT =
  "application/vnd.quantized-mesh;extensions=octvertexnormals-watermask";
const MAX_ZOOM = 14;
const PARALLEL = 8;

// Cesium Geographic TMS tile coords for (lon, lat) at zoom z.
function tileAt(lon, lat, z) {
  const lonStep = 360 / (1 << (z + 1));
  const latStep = 180 / (1 << z);
  return {
    x: Math.floor((lon + 180) / lonStep),
    y: Math.floor((lat + 90) / latStep), // TMS bottom-up
  };
}

// Tile coords covering [west, east] x [south, north] at zoom z.
function tilesCovering(z, west, south, east, north) {
  const sw = tileAt(west, south, z);
  const ne = tileAt(east, north, z);
  const out = [];
  for (let y = sw.y; y <= ne.y; y++) {
    for (let x = sw.x; x <= ne.x; x++) out.push({ z, x, y });
  }
  return out;
}

const REGIONS = [
  { name: "Mt.Fuji", west: 138.50, south: 35.20, east: 138.95, north: 35.55 },
  { name: "Tokyo",   west: 139.60, south: 35.55, east: 139.95, north: 35.80 },
];

const jobs = [];
for (const r of REGIONS) {
  for (let z = 0; z <= MAX_ZOOM; z++) {
    for (const t of tilesCovering(z, r.west, r.south, r.east, r.north)) {
      jobs.push({ ...t, region: r.name });
    }
  }
}

const stats = { ok: 0, miss: 0, err: 0, bytes: 0 };
let idx = 0;
const start = Date.now();

async function worker() {
  while (idx < jobs.length) {
    const j = jobs[idx++];
    const url = `${BASE}${PATH}/${j.z}/${j.x}/${j.y}.terrain`;
    try {
      const res = await fetch(url, { headers: { Accept: ACCEPT } });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        stats.ok++;
        stats.bytes += buf.byteLength;
      } else if (res.status === 404) {
        stats.miss++;
        await res.arrayBuffer();
      } else {
        stats.err++;
        console.error(`! ${res.status} ${url}`);
        await res.arrayBuffer();
      }
    } catch (e) {
      stats.err++;
      console.error(`! ${url}: ${e.message}`);
    }
    if ((stats.ok + stats.miss + stats.err) % 50 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[${elapsed}s] ${stats.ok + stats.miss + stats.err}/${jobs.length} ` +
          `ok=${stats.ok} miss=${stats.miss} err=${stats.err}`,
      );
    }
  }
}

console.log(
  `warming ${jobs.length} tiles across ${REGIONS.length} regions ` +
    `(z=0..${MAX_ZOOM}, ${PARALLEL} parallel) at ${BASE}${PATH}`,
);

await Promise.all(Array.from({ length: PARALLEL }, () => worker()));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(
  `done in ${elapsed}s: ok=${stats.ok} miss=${stats.miss} err=${stats.err} ` +
    `bytes=${(stats.bytes / 1024 / 1024).toFixed(1)} MiB`,
);
if (stats.err > 0) process.exit(1);

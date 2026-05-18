#!/usr/bin/env node
// Build all Rust crates under crates/ that should ship as WASM, then patch
// the wasm-bindgen glue to be compatible with the workerd runtime.
//
// Cloudflare requires .wasm imports to be resolved as `WebAssembly.Module`
// rather than the auto-instantiated namespace that wasm-pack assumes when
// run with `--target bundler`. We rewrite the main glue file accordingly:
// https://developers.cloudflare.com/workers/languages/rust/#workers-rs-vs-wasm-bindgen

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const crates = [
  { name: "reearth-terrain-wasm", snake: "reearth_terrain_wasm" },
];

for (const c of crates) {
  const crateDir = resolve(repoRoot, "crates", c.name);
  const outDir = resolve(repoRoot, "src/wasm", c.name);
  mkdirSync(outDir, { recursive: true });

  const mode = process.env.WASM_PROFILE === "dev" ? "--dev" : "--release";
  console.log(`[build-wasm] building ${c.name} (${mode})`);
  execSync(
    `wasm-pack build "${crateDir}" --target bundler --out-dir "${outDir}" --out-name ${c.snake} ${mode}`,
    { stdio: "inherit" },
  );

  patchGlue(outDir, c.snake);
  if (mode === "--release") optimizeWasm(outDir, c.snake);
}

function optimizeWasm(outDir, snake) {
  const wasm = resolve(outDir, `${snake}_bg.wasm`);
  const probe = spawnSync("wasm-opt", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.warn("[build-wasm] system wasm-opt not found on PATH; skipping optimization");
    return;
  }
  const before = statSync(wasm).size;
  // Enable wasm proposals that modern rustc emits by default. Without
  // these flags older binaryen (e.g. the Ubuntu LTS apt package) bails out
  // with "all used features should be allowed" on sign-extension and bulk
  // memory ops.
  const r = spawnSync(
    "wasm-opt",
    [
      "-Os",
      "--enable-sign-ext",
      "--enable-bulk-memory",
      "--enable-nontrapping-float-to-int",
      "--enable-multivalue",
      "--enable-mutable-globals",
      "--enable-reference-types",
      wasm,
      "-o",
      wasm,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("wasm-opt failed");
  const after = statSync(wasm).size;
  console.log(`[build-wasm] wasm-opt: ${before} -> ${after} bytes (-${before - after})`);
}

function patchGlue(outDir, snake) {
  const mainJs = resolve(outDir, `${snake}.js`);
  if (!existsSync(mainJs)) {
    throw new Error(`expected glue file not found: ${mainJs}`);
  }
  const patched =
`// Patched by scripts/build-wasm.mjs for the workerd runtime.
// See https://developers.cloudflare.com/workers/languages/rust/#workers-rs-vs-wasm-bindgen
import * as imports from "./${snake}_bg.js";
import wkmod from "./${snake}_bg.wasm";
import * as nodemod from "./${snake}_bg.wasm";

if (typeof process !== "undefined" && process.release?.name === "node") {
  imports.__wbg_set_wasm(nodemod);
} else {
  const instance = new WebAssembly.Instance(wkmod, {
    "./${snake}_bg.js": imports,
  });
  imports.__wbg_set_wasm(instance.exports);
}

export * from "./${snake}_bg.js";
`;
  writeFileSync(mainJs, patched);
  console.log(`[build-wasm] patched glue: ${mainJs}`);
}

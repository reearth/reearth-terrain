// Polyfill stubs for globals the miniflare-launched workerd in
// @cloudflare/vitest-pool-workers happens not to expose by default but
// that some transitive dependencies reference at import time.
//
// In production the worker runs on Cloudflare's workerd build, where these
// are available. Stubbing them only for tests is safe because none of the
// code paths we exercise here actually invoke GC finalization or weak refs.

// geotiff's pool.js references `FinalizationRegistry` at top-level when
// loading the module, even though we never use its worker-pool feature.
if (typeof (globalThis as Record<string, unknown>).FinalizationRegistry === "undefined") {
  (globalThis as Record<string, unknown>).FinalizationRegistry = class {
    register() {}
    unregister() {}
  };
}

// The wasm-bindgen glue (patched in scripts/build-wasm.mjs) auto-instantiates
// via the Node ESM branch when `process.release.name === "node"`. That branch
// expects `import * as foo from "./x.wasm"` to return the WASM exports — true
// in native Node ESM with `--experimental-wasm-modules` and in workerd at
// deploy time, but NOT in @cloudflare/vitest-pool-workers's bundler, which
// hands back `{ default: WebAssembly.Module }`. Re-instantiate properly so
// `wasm.__wbindgen_*` exports actually resolve to functions.
// Pull in the patched outer glue first so its (broken-in-this-env) init block
// runs before we overwrite the `wasm` binding with a real instance.
import "./wasm/reearth-terrain-wasm/reearth_terrain_wasm.js";
import * as wasmGlue from "./wasm/reearth-terrain-wasm/reearth_terrain_wasm_bg.js";
// In workerd the default export of a .wasm import is a WebAssembly.Module.
import wasmModule from "./wasm/reearth-terrain-wasm/reearth_terrain_wasm_bg.wasm";

const wasmInstance = new WebAssembly.Instance(wasmModule as WebAssembly.Module, {
  "./reearth_terrain_wasm_bg.js": wasmGlue as unknown as WebAssembly.ModuleImports,
});
(wasmGlue as unknown as { __wbg_set_wasm: (v: unknown) => void }).__wbg_set_wasm(
  wasmInstance.exports,
);

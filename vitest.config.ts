import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Run unit tests inside the same workerd runtime the worker ships on.
// That gives tests real `caches`, `crypto.subtle`, R2 (via miniflare), and
// transparent .wasm imports — the latter matters because most modules in
// `src/` reach the WASM codec transitively through `tilesets.ts` -> `dem.ts`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    workers: {
      singleWorker: true,
    },
  },
});

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

// The built viewer is served at /viewer/ by the worker's static assets
// (public/), hence the relative base and the outDir inside public/.
export default defineConfig({
  root,
  base: "./",
  build: {
    outDir: join(root, "../public/viewer"),
    emptyOutDir: true,
  },
});

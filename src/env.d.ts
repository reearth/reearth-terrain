// Bindings and secrets that `wrangler types` does not put in
// `worker-configuration.d.ts` on its own — secrets are never generated, and
// regenerating the whole file to pick up one binding rewrites every runtime
// type in it, which is a large diff for a small addition.
//
// Declared here instead. Run `wrangler types` when the runtime itself needs
// updating, not when this list grows.

interface Env {
  /**
   * Tile-demand events, read by okibi. Declared in `wrangler.toml`.
   *
   * See `src/okibi.ts`.
   */
  TILE_DEMAND: AnalyticsEngineDataset;

  /**
   * Shared with okibi's executor. A request carrying it is okibi warming a
   * tile rather than somebody wanting one, and is kept out of the demand it
   * would otherwise become. Unset means nothing is treated as warm, which
   * over-counts demand rather than letting anyone edit the ledger.
   *
   *   wrangler secret put OKIBI_WARM_SECRET
   */
  OKIBI_WARM_SECRET?: string;
}

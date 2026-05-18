// Hand-written environment shape for the mirror worker. We don't run
// `wrangler types` here to avoid a second generated-types file under
// source control; the binding set is small enough to maintain by hand,
// and changes to it are intentional.

interface Env {
  R2: R2Bucket;
  PMTILES_MIRROR: Workflow;

  ENVIRONMENT: string;
  UPSTREAM_BASE: string;
  MIRROR_PREFIX: string;
  PART_SIZE: string;
  RETAIN_VERSIONS: string;

  // Bearer token for the manual /runs API. Set via:
  //   wrangler secret put MIRROR_TOKEN
  MIRROR_TOKEN?: string;
}

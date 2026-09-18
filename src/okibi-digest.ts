// The daily demand digest, taken from this worker's own cron.
//
// Analytics Engine keeps three months and a demand model wants longer, so a
// day of events is aggregated into a digest and put somewhere that does not
// expire. The alternative is a scheduled CI job; a Cloudflare cron is
// preferred because it does not switch itself off after sixty quiet days.
//
// The aggregation is not written here. `assembleDigest` is the same compiled
// function `okibi digest` runs: which cell an unplaced request belongs to, how
// a tie between two equally hot tiles breaks, and what happens to a row that
// cannot be placed are decisions that fail silently when two implementations
// disagree — and a digest that means something slightly different is a plan
// that warms somewhere slightly wrong.
//
// See https://github.com/reearth/okibi, spec/demand-digest.md.

import { assembleDigest, digestQueries } from "@reearth/okibi";

/** This service's name, as it appears in its own events. */
const SERVICE = "terrain";

/** Where digests live in the bucket, kept away from anything cached. */
const PREFIX = "okibi/digests";

export async function takeDigest(env: Env, date: string): Promise<void> {
  if (!env.OKIBI_CF_API_TOKEN || !env.OKIBI_ACCOUNT_ID) {
    console.warn("okibi: no SQL API credentials, skipping the digest");
    return;
  }

  // The top-tiles query is per service — its row limit is a row count, and one
  // query ordered by demand would spend all of it on whichever service is
  // busiest. Naming one service here is what makes this service's own cells
  // describable.
  const { cells, topTiles } = digestQueries({ services: [SERVICE] }, date);
  if (!topTiles) throw new Error(`okibi: no top-tiles query for ${SERVICE}`);

  const [cellRows, tileRows] = await Promise.all([runSql(env, cells), runSql(env, topTiles)]);

  // `assembleDigest` crosses the wasm boundary, so its result arrives as
  // `any`. The digest records are only ever written back out as JSON here,
  // and the shape they have to have is the spec's, not this file's.
  const { records, skipped } = assembleDigest(cellRows, tileRows, date, 20) as {
    records: unknown[];
    skipped: { unknown_kind: number; unplaceable: number; cells_without_top: number };
  };

  // Nothing is dropped quietly: a digest that covered less than it was asked
  // to would otherwise read as a quiet day.
  if (skipped.unknown_kind || skipped.unplaceable || skipped.cells_without_top) {
    console.warn("okibi: not everything became a record", skipped);
  }

  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await env.R2.put(`${PREFIX}/${date}.jsonl`, jsonl);

  console.log(`okibi: ${records.length} cells for ${date}`);
}

async function runSql(env: Env, sql: string): Promise<unknown[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.OKIBI_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OKIBI_CF_API_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: sql,
    },
  );

  if (!response.ok) {
    throw new Error(`the SQL API answered ${response.status}: ${await response.text()}`);
  }

  const { data, rows } = (await response.json()) as { data: unknown[]; rows: number };

  // A gap between what the API counted and what came back as rows means the
  // query and the reader have drifted apart, which otherwise shows up as a
  // digest quietly missing most of its cells.
  if (rows !== data.length) {
    throw new Error(`the SQL API returned ${rows} rows and ${data.length} could be read`);
  }
  return data;
}

/** Yesterday, in UTC. A day still being written to would be a digest of part
 *  of a day, filed under the whole of it. */
export function dayBefore(scheduledTime: number): string {
  return new Date(scheduledTime - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

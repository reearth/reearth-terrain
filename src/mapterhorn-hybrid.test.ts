// `revalidated` decides how long a point's height is kept (src/heights-cache.ts),
// so it has to make the same branch decision `read` does: planet below z13,
// the regional mirror where one exists, upstream everywhere else.

import { describe, expect, it } from "vitest";

import type { DemSource } from "./dem.js";
import {
  HybridMapterhornSource,
  type MirroredMapterhornSource,
  regionalArchiveName,
} from "./mapterhorn-mirror.js";

/** An R2 bucket whose only content is the mirror's pointers. */
function bucket(archives: string[]): R2Bucket {
  const objects = archives.map((a) => ({ key: `mirror/mapterhorn/${a}.latest.json` }));
  return {
    list: async () => ({ objects, truncated: false, delimitedPrefixes: [] }),
  } as unknown as R2Bucket;
}

const upstream: DemSource = {
  name: "mapterhorn",
  read: async () => null,
  revalidated: async () => true,
};

function hybrid(mirrored: string[], up: DemSource = upstream) {
  return new HybridMapterhornSource(
    {} as MirroredMapterhornSource,
    up,
    bucket(["planet.pmtiles", ...mirrored]),
  );
}

describe("HybridMapterhornSource.revalidated", () => {
  it("says a planet tile is pinned", async () => {
    expect(await hybrid([]).revalidated(12, 3638, 1612)).toBe(false);
  });

  it("says a tile in a mirrored regional archive is pinned", async () => {
    const archive = regionalArchiveName(14, 14552, 6451);
    expect(await hybrid([archive]).revalidated(14, 14552, 6451)).toBe(false);
  });

  it("says a tile outside the mirror is rechecked upstream", async () => {
    const elsewhere = regionalArchiveName(14, 0, 0);
    expect(await hybrid([elsewhere]).revalidated(14, 14552, 6451)).toBe(true);
  });

  it("follows an upstream that never rechecks", async () => {
    const pinned: DemSource = { name: "pinned", read: async () => null };
    expect(await hybrid([], pinned).revalidated(14, 14552, 6451)).toBe(false);
  });
});

// `revalidated` decides how long a point's height is kept (src/heights-cache.ts),
// so it has to make the same branch decision `read` does: planet below z13,
// the regional mirror where one exists, upstream everywhere else.

import { describe, expect, it, vi } from "vitest";

import type { DemSource } from "./dem.js";
import {
  HybridMapterhornSource,
  type MirroredMapterhornSource,
  regionalArchiveName,
} from "./mapterhorn-mirror.js";
import { READ_TIMEOUT_MS } from "./single-flight.js";

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

describe("HybridMapterhornSource, after a request goes away", () => {
  it("does not wait forever on a listing a dead request left behind", async () => {
    // The source lives as long as the isolate, and the runtime never settles
    // a read whose request went away. Kept as a promise for the hour, that
    // listing used to hang every tile above the planet archive.
    vi.useFakeTimers();
    try {
      let lists = 0;
      const r2 = {
        list: () =>
          lists++ === 0
            ? new Promise(() => {})
            : Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
      } as unknown as R2Bucket;
      const source = new HybridMapterhornSource({} as MirroredMapterhornSource, upstream, r2);

      void source.revalidated(14, 14552, 6451);
      const second = source.revalidated(14, 14552, 6451);
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);

      await expect(Promise.race([second, Promise.resolve("hung")])).resolves.toBe(true);
      expect(lists).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

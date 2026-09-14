// PMTiles stores tiles in Hilbert order, so a request that touches many
// nearby tiles touches many nearby byte ranges. These tests pin that the
// source turns those into a few reads rather than one per tile, and that the
// bytes it hands back are still exactly the bytes that were asked for.

import { describe, expect, it, vi } from "vitest";

import { R2PmtilesSource } from "./protomaps.js";

const MiB = 1024 * 1024;

/** An archive whose byte at position i is i mod 251, so any range is checkable. */
function archive(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

function expected(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  return bytes.slice(offset, Math.min(offset + length, bytes.byteLength));
}

function countingBucket(bytes: Uint8Array) {
  const get = vi.fn(
    async (_key: string, opts?: { range?: { offset: number; length: number } }) => {
      const offset = opts?.range?.offset ?? 0;
      const length = opts?.range?.length ?? bytes.byteLength - offset;
      if (offset >= bytes.byteLength) return null;
      const slice = bytes.slice(offset, Math.min(offset + length, bytes.byteLength));
      return {
        httpEtag: '"archive-v1"',
        size: bytes.byteLength,
        arrayBuffer: async () => slice.buffer,
      };
    },
  );
  return { bucket: { get } as unknown as R2Bucket, get };
}

describe("R2PmtilesSource", () => {
  it("returns exactly the requested range", async () => {
    const bytes = archive(3 * MiB);
    const { bucket } = countingBucket(bytes);
    const src = new R2PmtilesSource(bucket, "mirror/a.pmtiles");

    const res = await src.getBytes(1234, 500);
    expect(new Uint8Array(res.data)).toEqual(expected(bytes, 1234, 500));
  });

  it("serves neighbouring tiles out of one read", async () => {
    const bytes = archive(3 * MiB);
    const { bucket, get } = countingBucket(bytes);
    const src = new R2PmtilesSource(bucket, "mirror/b.pmtiles");

    // 200 small ranges walking through the same megabyte, the shape a
    // sparse-point request produces.
    for (let i = 0; i < 200; i++) {
      const res = await src.getBytes(i * 4096, 3000);
      expect(new Uint8Array(res.data)).toEqual(expected(bytes, i * 4096, 3000));
    }
    expect(get.mock.calls.length).toBe(1);
  });

  it("buys a chunk once even when the reads race", async () => {
    const bytes = archive(3 * MiB);
    const { bucket, get } = countingBucket(bytes);
    const src = new R2PmtilesSource(bucket, "mirror/c.pmtiles");

    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) => src.getBytes(i * 1024, 512)),
    );
    results.forEach((res, i) => {
      expect(new Uint8Array(res.data)).toEqual(expected(bytes, i * 1024, 512));
    });
    expect(get.mock.calls.length).toBe(1);
  });

  it("stitches a range that straddles a chunk boundary", async () => {
    const bytes = archive(3 * MiB);
    const { bucket, get } = countingBucket(bytes);
    const src = new R2PmtilesSource(bucket, "mirror/d.pmtiles");

    const offset = MiB - 100;
    const res = await src.getBytes(offset, 400);
    expect(new Uint8Array(res.data)).toEqual(expected(bytes, offset, 400));
    expect(get.mock.calls.length).toBe(2);
  });

  it("reads a range larger than a chunk in one pass, without caching it", async () => {
    const bytes = archive(3 * MiB);
    const { bucket, get } = countingBucket(bytes);
    const src = new R2PmtilesSource(bucket, "mirror/e.pmtiles");

    const res = await src.getBytes(0, 2 * MiB);
    expect(new Uint8Array(res.data)).toEqual(expected(bytes, 0, 2 * MiB));
    expect(get.mock.calls.length).toBe(1);

    // It was passed through, so a later small read still has to fetch.
    await src.getBytes(10, 10);
    expect(get.mock.calls.length).toBe(2);
  });

  it("hands back a short range at the end of the archive", async () => {
    const size = MiB + 777;
    const bytes = archive(size);
    const { bucket } = countingBucket(bytes);
    const src = new R2PmtilesSource(bucket, "mirror/f.pmtiles");

    const res = await src.getBytes(size - 100, 4096);
    expect(new Uint8Array(res.data)).toEqual(expected(bytes, size - 100, 4096));
    expect(res.data.byteLength).toBe(100);
  });

  it("reports the archive's etag so pmtiles can spot a rotation", async () => {
    const { bucket } = countingBucket(archive(2 * MiB));
    const src = new R2PmtilesSource(bucket, "mirror/g.pmtiles");

    expect((await src.getBytes(0, 16)).etag).toBe('"archive-v1"');
  });

  it("keys its cache to the archive it was built for", async () => {
    const bytes = archive(2 * MiB);
    const { bucket } = countingBucket(bytes);
    expect(new R2PmtilesSource(bucket, "mirror/h.pmtiles").getKey()).toBe(
      "r2://mirror/h.pmtiles",
    );
  });
});

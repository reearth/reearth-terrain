// Workflow that mirrors one Mapterhorn PMTiles archive into R2.
//
// Upstream Mapterhorn distributes the global DEM as:
//   - one large `planet.pmtiles` covering z0–z12 (~700 GB), and
//   - per-z6 regional `{z}-{x}-{y}.pmtiles` archives covering z13–z17
//     (the list is published at https://mapterhorn.com/coverage).
//
// Unlike Protomaps' daily build, Mapterhorn's URLs are stable and the
// version is conveyed via the upstream object's `Last-Modified` header.
// We snapshot each archive under `${PREFIX}/{YYYYMMDD}/{archive}` so a
// new upload doesn't overwrite the previous version and the main worker
// (when it eventually switches to R2-backed Mapterhorn reads) can pin
// to a specific snapshot.
//
// One Workflow instance mirrors a single archive. Mirroring the z13+
// regional set is done by enqueueing one instance per `{z6}.pmtiles`.
// That keeps each instance's part count bounded, and lets a failed
// region retry independently without redoing the planet.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface MapterhornMirrorParams {
  /**
   * Archive filename under `MAPTERHORN_UPSTREAM_BASE`. Defaults to
   * `planet.pmtiles`. For regional z13+ mirroring, pass e.g.
   * `"6-33-22.pmtiles"`.
   */
  archive?: string;
}

interface InitResult {
  archive: string;
  url: string;
  version: string;
  size: number;
  partSize: number;
  partCount: number;
  uploadId: string;
  key: string;
}

interface CompletedPart {
  partNumber: number;
  etag: string;
}

const DEFAULT_ARCHIVE = "planet.pmtiles";
// Loose validation — filenames are joined into URLs and R2 keys, so we
// reject anything that could traverse the prefix.
const ARCHIVE_NAME = /^[A-Za-z0-9._-]+\.pmtiles$/;

export class MapterhornMirrorWorkflow extends WorkflowEntrypoint<Env, MapterhornMirrorParams> {
  override async run(event: WorkflowEvent<MapterhornMirrorParams>, step: WorkflowStep): Promise<unknown> {
    const archive = event.payload.archive?.trim() || DEFAULT_ARCHIVE;
    if (!ARCHIVE_NAME.test(archive)) {
      throw new Error(`invalid archive name: ${archive}`);
    }

    const init = await step.do("init", async (): Promise<InitResult> => {
      const url = `${this.env.MAPTERHORN_UPSTREAM_BASE}/${archive}`;
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) throw new Error(`HEAD ${url} -> ${head.status}`);
      const len = head.headers.get("content-length");
      if (!len) throw new Error(`HEAD ${url} did not return content-length`);
      const size = Number.parseInt(len, 10);
      if (!Number.isFinite(size) || size <= 0) throw new Error(`bad content-length: ${len}`);

      // Mapterhorn versions don't appear in the URL; use Last-Modified
      // as the snapshot tag so we can keep multiple versions side by
      // side and the main worker can pin to one.
      const lm = head.headers.get("last-modified");
      const lmDate = lm ? new Date(Date.parse(lm)) : null;
      const version = lmDate && !Number.isNaN(lmDate.getTime())
        ? formatUtcDate(lmDate)
        : formatUtcDate(new Date());

      const partSize = Number.parseInt(this.env.MAPTERHORN_PART_SIZE, 10);
      if (!Number.isFinite(partSize) || partSize < 5 * 1024 * 1024) {
        throw new Error(`MAPTERHORN_PART_SIZE must be >= 5 MiB, got ${this.env.MAPTERHORN_PART_SIZE}`);
      }
      const partCount = Math.ceil(size / partSize);
      if (partCount > 10_000) {
        throw new Error(
          `would require ${partCount} parts for ${size}B; R2 multipart max is 10000. Bump MAPTERHORN_PART_SIZE.`,
        );
      }

      const key = `${this.env.MAPTERHORN_MIRROR_PREFIX}/${version}/${archive}`;
      const mpu = await this.env.R2.createMultipartUpload(key, {
        httpMetadata: { contentType: "application/vnd.pmtiles" },
        customMetadata: {
          upstream: url,
          mirroredAt: new Date().toISOString(),
          version,
        },
      });

      return { archive, url, version, size, partSize, partCount, uploadId: mpu.uploadId, key };
    });

    // Sequential range fetches — same rationale as the Protomaps
    // workflow: keeps peak memory bounded and a transient hiccup only
    // retries one part.
    const parts: CompletedPart[] = [];
    for (let i = 0; i < init.partCount; i++) {
      const partNumber = i + 1;
      const start = i * init.partSize;
      const endExclusive = Math.min(init.size, start + init.partSize);
      const part = await step.do(`part-${partNumber}`, async (): Promise<CompletedPart> => {
        const res = await fetch(init.url, {
          headers: { range: `bytes=${start}-${endExclusive - 1}` },
        });
        if (res.status !== 206 && res.status !== 200) {
          throw new Error(`range fetch ${init.url} [${start}-${endExclusive - 1}] -> ${res.status}`);
        }
        const body = await res.arrayBuffer();
        if (body.byteLength !== endExclusive - start) {
          throw new Error(
            `range fetch returned ${body.byteLength} bytes, expected ${endExclusive - start}`,
          );
        }
        const mpu = this.env.R2.resumeMultipartUpload(init.key, init.uploadId);
        const uploaded = await mpu.uploadPart(partNumber, body);
        return { partNumber, etag: uploaded.etag };
      });
      parts.push(part);
    }

    await step.do("complete", async () => {
      const mpu = this.env.R2.resumeMultipartUpload(init.key, init.uploadId);
      await mpu.complete(parts);
    });

    // Per-archive pointer file: `{archive}.latest.json` so multiple
    // archives (planet + regionals) coexist under the same prefix.
    await step.do("write-latest", async () => {
      const body = JSON.stringify({
        archive: init.archive,
        version: init.version,
        key: init.key,
        size: init.size,
        upstream: init.url,
        mirroredAt: new Date().toISOString(),
      });
      await this.env.R2.put(`${this.env.MAPTERHORN_MIRROR_PREFIX}/${init.archive}.latest.json`, body, {
        httpMetadata: { contentType: "application/json" },
      });
    });

    await step.do("retain", async () => {
      const retain = Number.parseInt(this.env.MAPTERHORN_RETAIN_VERSIONS, 10);
      if (!Number.isFinite(retain) || retain < 1) return;
      // Layout: `${PREFIX}/{version}/{archive}`. List with the archive
      // suffix and group by version directory so retention is per-archive.
      const listed = await this.env.R2.list({ prefix: `${this.env.MAPTERHORN_MIRROR_PREFIX}/` });
      const versions: string[] = [];
      const tail = `/${init.archive}`;
      const prefixLen = `${this.env.MAPTERHORN_MIRROR_PREFIX}/`.length;
      for (const o of listed.objects) {
        if (!o.key.endsWith(tail)) continue;
        const rest = o.key.slice(prefixLen);
        const slash = rest.indexOf("/");
        if (slash > 0) versions.push(rest.slice(0, slash));
      }
      versions.sort().reverse();
      const toDelete = versions
        .slice(retain)
        .map((v) => `${this.env.MAPTERHORN_MIRROR_PREFIX}/${v}/${init.archive}`);
      if (toDelete.length > 0) await this.env.R2.delete(toDelete);
    });

    return {
      ok: true,
      archive: init.archive,
      version: init.version,
      key: init.key,
      size: init.size,
      parts: parts.length,
    };
  }
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}

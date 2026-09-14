import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetPolicy, loadPolicy, OFF } from "./policy.js";

beforeEach(() => {
  __resetPolicy();
});

function kv(get: () => Promise<unknown>) {
  const fn = vi.fn(get);
  return { env: { CONFIG: { get: fn } as unknown as KVNamespace }, get: fn };
}

describe("loadPolicy", () => {
  it("refuses nobody when there is no namespace bound", async () => {
    expect(await loadPolicy({})).toEqual(OFF);
  });

  it("refuses nobody when the namespace is empty", async () => {
    const { env } = kv(async () => null);
    expect(await loadPolicy(env)).toEqual(OFF);
  });

  it("reads the document", async () => {
    const { env } = kv(async () => ({
      rateLimit: "enforce",
      origins: ["http://localhost", "http://127.0.0.1"],
      crawl: "observe",
      crawlCells: 96,
      allow: ["192.0.2.1"],
      deny: [],
    }));
    expect(await loadPolicy(env)).toEqual({
      rateLimit: "enforce",
      origins: ["http://localhost", "http://127.0.0.1"],
      crawl: "observe",
      crawlCells: 96,
      allow: ["192.0.2.1"],
      deny: [],
    });
  });

  it("treats an unknown mode as off rather than guessing", async () => {
    const { env } = kv(async () => ({ rateLimit: "ENFORCE!", crawl: 1 }));
    const p = await loadPolicy(env);
    expect(p.rateLimit).toBe("off");
    expect(p.crawl).toBe("off");
  });

  it("drops entries that are not strings", async () => {
    const { env } = kv(async () => ({ origins: ["ok", 5, null, ""], allow: "nope" }));
    const p = await loadPolicy(env);
    expect(p.origins).toEqual(["ok"]);
    expect(p.allow).toEqual([]);
  });

  it("falls back to the default threshold for a nonsense one", async () => {
    const { env } = kv(async () => ({ crawlCells: -3 }));
    expect((await loadPolicy(env)).crawlCells).toBe(OFF.crawlCells);
  });

  it("reads once a minute, not once a request", async () => {
    const { env, get } = kv(async () => ({ rateLimit: "enforce" }));
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) await loadPolicy(env, t0 + i);
    expect(get).toHaveBeenCalledTimes(1);

    await loadPolicy(env, t0 + 61_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("serves everybody when the read fails and nothing is known yet", async () => {
    const { env } = kv(async () => {
      throw new Error("KV is having a day");
    });
    expect(await loadPolicy(env)).toEqual(OFF);
  });

  it("keeps the last good policy when a later read fails", async () => {
    // Losing sight of the rules is not a reason to change who gets served.
    let fail = false;
    const { env } = kv(async () => {
      if (fail) throw new Error("KV is having a day");
      return { rateLimit: "enforce", origins: ["http://localhost"] };
    });
    const t0 = 1_000_000;
    expect((await loadPolicy(env, t0)).rateLimit).toBe("enforce");

    fail = true;
    const later = await loadPolicy(env, t0 + 61_000);
    expect(later.rateLimit).toBe("enforce");
    expect(later.origins).toEqual(["http://localhost"]);
  });
});

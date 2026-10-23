import { waitUntil } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { shared } from "./single-flight.js";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

/** A promise that never settles — what the runtime leaves behind. */
const never = <T>() => new Promise<T>(() => {});

describe("shared", () => {
  it("runs the work once for concurrent callers", async () => {
    const cache = new Map<string, Promise<number>>();
    const make = vi.fn(async () => 7);

    const all = await Promise.all(
      Array.from({ length: 5 }, () =>
        shared(cache, "k", make, { timeoutMs: 1000, keepResolved: false }),
      ),
    );
    expect(all).toEqual([7, 7, 7, 7, 7]);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("memoizes a resolved entry when asked to", async () => {
    const cache = new Map<string, Promise<number>>();
    const make = vi.fn(async () => 7);

    await shared(cache, "k", make, { timeoutMs: 1000 });
    await shared(cache, "k", make, { timeoutMs: 1000 });
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("forgets a resolved entry when it is only deduplicating", async () => {
    const cache = new Map<string, Promise<number>>();
    const make = vi.fn(async () => 7);

    await shared(cache, "k", make, { timeoutMs: 1000, keepResolved: false });
    await shared(cache, "k", make, { timeoutMs: 1000, keepResolved: false });
    expect(make).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("forgets a rejected entry so the next caller retries", async () => {
    const cache = new Map<string, Promise<number>>();
    const make = vi.fn(async () => {
      throw new Error("nope");
    });

    await expect(shared(cache, "k", make, { timeoutMs: 1000 })).rejects.toThrow("nope");
    await expect(shared(cache, "k", make, { timeoutMs: 1000 })).rejects.toThrow("nope");
    expect(make).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("does not wait forever on a promise a dead request left behind", async () => {
    // This is the whole point. Workers cancels the I/O of a request that goes
    // away, and the promise it was waiting on never settles. Parked in a
    // cache that outlives the request, it used to hang every later caller —
    // the runtime's "your Worker's code had hung" cancellation.
    vi.useFakeTimers();
    try {
      const cache = new Map<string, Promise<number>>();
      cache.set("k", never<number>());
      const make = vi.fn(async () => 7);

      const pending = shared(cache, "k", make, { timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      await expect(pending).resolves.toBe(7);
      expect(make).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the stale entry so the next caller does not pay the wait again", async () => {
    vi.useFakeTimers();
    try {
      const cache = new Map<string, Promise<number>>();
      const stale = never<number>();
      cache.set("k", stale);

      const first = shared(cache, "k", async () => 7, { timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);
      await first;

      expect(cache.get("k")).not.toBe(stale);
      await expect(
        shared(cache, "k", async () => 9, { timeoutMs: 5000 }),
      ).resolves.toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns promptly when the entry settles before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const cache = new Map<string, Promise<number>>();
      cache.set("k", Promise.resolve(3));
      const make = vi.fn(async () => 7);

      // No timer advance: a healthy entry must not be gated on the deadline.
      await expect(shared(cache, "k", make, { timeoutMs: 60_000 })).resolves.toBe(3);
      expect(make).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the work it starts alive past the request that started it", async () => {
    // A client that goes away must not take a read others are waiting on
    // down with it. Only the starter hands it over; a joiner has nothing new.
    vi.mocked(waitUntil).mockClear();
    const cache = new Map<string, Promise<number>>();
    let finish!: (n: number) => void;
    const work = new Promise<number>((resolve) => (finish = resolve));

    const first = shared(cache, "k", () => work, { timeoutMs: 1000, keepResolved: false });
    const second = shared(cache, "k", async () => 9, { timeoutMs: 1000, keepResolved: false });
    expect(waitUntil).toHaveBeenCalledTimes(1);

    finish(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    // What it handed over is this work, not a copy that settles on its own.
    await expect(vi.mocked(waitUntil).mock.calls[0]![0]).resolves.toBe(7);
  });

  it("does not let a failure it hands over go unhandled", async () => {
    vi.mocked(waitUntil).mockClear();
    const cache = new Map<string, Promise<number>>();
    await expect(
      shared(cache, "k", async () => { throw new Error("nope"); }, { timeoutMs: 1000 }),
    ).rejects.toThrow("nope");
    await expect(vi.mocked(waitUntil).mock.calls[0]![0]).resolves.toBeUndefined();
  });
});

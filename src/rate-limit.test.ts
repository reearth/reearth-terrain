import { beforeEach, describe, expect, it, vi } from "vitest";

import { OFF, type Policy } from "./policy.js";
import {
  __resetTracks,
  clientsOn,
  cellOf,
  checkRateLimit,
  clientKey,
  noteTile,
  refusal,
} from "./rate-limit.js";

beforeEach(() => {
  __resetTracks();
});

function policy(over: Partial<Policy> = {}): Policy {
  return { ...OFF, ...over };
}

function request(ip: string): Request {
  return new Request("https://terrain.reearth.land/cesium-mesh/elevation/14/1/1.terrain", {
    headers: { "CF-Connecting-IP": ip },
  });
}

const limiter = (success: boolean) => ({
  TILE_RATE_LIMIT: { limit: vi.fn(async () => ({ success })) },
});

describe("clientKey", () => {
  it("counts an address and an origin together", () => {
    // Address alone would put a university behind one NAT on a single
    // budget; origin alone would put every dev server in the world sharing a
    // default port on one, and there are over a hundred of those.
    expect(clientKey(request("192.0.2.1"), "http://localhost:1234")).toBe(
      "192.0.2.1|http://localhost:1234",
    );
    expect(clientKey(request("192.0.2.1"), "http://localhost:1234")).not.toBe(
      clientKey(request("192.0.2.2"), "http://localhost:1234"),
    );
    expect(clientKey(request("192.0.2.1"), "http://localhost:1234")).not.toBe(
      clientKey(request("192.0.2.1"), "http://localhost:5678"),
    );
  });
});

describe("checkRateLimit", () => {
  it("serves everyone when the policy is off", async () => {
    const env = limiter(false);
    expect(await checkRateLimit("k", "http://localhost:1234", policy(), env)).toBe("allow");
    expect(env.TILE_RATE_LIMIT.limit).not.toHaveBeenCalled();
  });

  it("leaves origins outside the list alone", async () => {
    const env = limiter(false);
    const p = policy({ rateLimit: "enforce", origins: ["http://localhost"] });
    expect(await checkRateLimit("k", "https://example.com", p, env)).toBe("allow");
    expect(env.TILE_RATE_LIMIT.limit).not.toHaveBeenCalled();
  });

  it("refuses an origin over its share when enforcing", async () => {
    const p = policy({ rateLimit: "enforce", origins: ["http://localhost"] });
    expect(await checkRateLimit("k", "http://localhost:1234", p, limiter(false))).toBe(
      "refuse",
    );
  });

  it("only writes it down when observing", async () => {
    const p = policy({ rateLimit: "observe", origins: ["http://localhost"] });
    expect(await checkRateLimit("k", "http://localhost:1234", p, limiter(false))).toBe(
      "observed",
    );
  });

  it("serves a client still inside its share", async () => {
    const p = policy({ rateLimit: "enforce", origins: ["http://localhost"] });
    expect(await checkRateLimit("k", "http://localhost:1234", p, limiter(true))).toBe(
      "allow",
    );
  });

  it("serves everyone when the binding is missing, as under wrangler dev", async () => {
    const p = policy({ rateLimit: "enforce", origins: ["http://localhost"] });
    expect(await checkRateLimit("k", "http://localhost:1234", p, {})).toBe("allow");
  });

  it("honours an allow entry ahead of the limit", async () => {
    const p = policy({
      rateLimit: "enforce",
      origins: ["http://localhost"],
      allow: ["192.0.2.1"],
    });
    const key = clientKey(request("192.0.2.1"), "http://localhost:1234");
    expect(await checkRateLimit(key, "http://localhost:1234", p, limiter(false))).toBe(
      "allow",
    );
  });

  it("refuses a deny entry even when the policy is otherwise off", async () => {
    const p = policy({ deny: ["https://example.invalid"] });
    const key = clientKey(request("192.0.2.1"), "https://example.invalid");
    expect(await checkRateLimit(key, "https://example.invalid", p, limiter(true))).toBe(
      "refuse",
    );
  });
});

describe("cellOf", () => {
  it("collapses a tile to the z8 cell holding it", () => {
    expect(cellOf(14, 14549, 6450)).toBe("8/227/100");
    expect(cellOf(14, 14550, 6450)).toBe("8/227/100"); // the neighbour, same cell
    expect(cellOf(8, 227, 100)).toBe("8/227/100");
  });

  it("leaves coarse zooms as they are", () => {
    expect(cellOf(3, 1, 2)).toBe("3/1/2");
  });
});

describe("noteTile", () => {
  const sweeping = policy({ crawl: "enforce", crawlCells: 64 });

  it("leaves a viewport alone, however many tiles it loads", () => {
    // A screenful at z14 is hundreds of tiles, all inside one or two z8
    // cells. Breadth is what separates it from a sweep, not volume.
    let last;
    for (let i = 0; i < 600; i++) {
      last = noteTile("viewer", cellOf(14, 14549 + (i % 30), 6450 + Math.floor(i / 30)), sweeping);
    }
    expect(last!.requests).toBe(600);
    expect(last!.cells).toBeLessThan(64);
    expect(last!.decision).toBe("allow");
  });

  it("catches a client walking across the world", () => {
    let last;
    for (let i = 0; i < 400; i++) {
      last = noteTile("sweeper", cellOf(14, i * 256, 6450), sweeping);
    }
    expect(last!.decision).toBe("refuse");
  });

  it("catches a sweep taken in random order", () => {
    // The point of counting cells rather than consecutive tiles: shuffling
    // the order does not hide it.
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 60000;
    let last;
    for (let i = 0; i < 400; i++) {
      last = noteTile("shuffled", cellOf(14, rnd(), rnd() % 16000), sweeping);
    }
    expect(last!.decision).toBe("refuse");
  });

  it("needs volume as well as breadth", () => {
    // Someone opening a world map briefly touches many cells. Too few
    // requests to be a sweep.
    let last;
    for (let i = 0; i < 100; i++) {
      last = noteTile("browser", cellOf(14, i * 256, 6450), sweeping);
    }
    expect(last!.cells).toBeGreaterThanOrEqual(64);
    expect(last!.decision).toBe("allow");
  });

  it("only writes it down when observing", () => {
    const p = policy({ crawl: "observe", crawlCells: 64 });
    let last;
    for (let i = 0; i < 400; i++) last = noteTile("obs", cellOf(14, i * 256, 6450), p);
    expect(last!.decision).toBe("observed");
  });

  it("forgets a client once its minute is over", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 400; i++) {
      noteTile("slow", cellOf(14, i * 256, 6450), sweeping, t0);
    }
    const after = noteTile("slow", cellOf(14, 0, 6450), sweeping, t0 + 61_000);
    expect(after.requests).toBe(1);
    expect(after.decision).toBe("allow");
  });

  it("does nothing at all when crawl detection is off", () => {
    let last;
    for (let i = 0; i < 400; i++) last = noteTile("off", cellOf(14, i * 256, 6450), policy());
    expect(last!.decision).toBe("allow");
    expect(last!.requests).toBe(0);
  });

  it("leaves an allowed client unwatched", () => {
    const p = policy({ crawl: "enforce", crawlCells: 64, allow: ["https://ours.example"] });
    const key = clientKey(request("192.0.2.1"), "https://ours.example");
    let last;
    for (let i = 0; i < 400; i++) last = noteTile(key, cellOf(14, i * 256, 6450), p);
    expect(last!.decision).toBe("allow");
  });
});

describe("clientsOn", () => {
  const watching = policy({ crawl: "observe", crawlCells: 64 });

  it("counts the distinct clients seen on one origin", () => {
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      noteTile(`${ip}|http://localhost:1234`, cellOf(14, 1, 1), watching);
    }
    noteTile("198.51.100.7|https://example.com", cellOf(14, 1, 1), watching);

    expect(clientsOn("http://localhost:1234")).toBe(3);
    expect(clientsOn("https://example.com")).toBe(1);
    expect(clientsOn("https://nobody.example")).toBe(0);
  });

  it("does not confuse one origin with another that extends it", () => {
    noteTile("192.0.2.1|http://localhost:1234", cellOf(14, 1, 1), watching);
    noteTile("192.0.2.1|http://localhost:12340", cellOf(14, 1, 1), watching);
    expect(clientsOn("http://localhost:1234")).toBe(1);
  });
});

describe("refusal", () => {
  it("says where to get the data instead", async () => {
    const res = refusal("sweep");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = await res.text();
    expect(body).toContain("tiles.mapterhorn.com");
    expect(body).toContain("EGM2008");
  });

  it("explains the volume limit differently from the sweep", async () => {
    expect(await refusal("rate").text()).toContain("too many requests");
    expect(await refusal("sweep").text()).toContain("walking the tile grid");
  });

  it("says what the service does and does not undertake", async () => {
    for (const reason of ["rate", "sweep"] as const) {
      const body = await refusal(reason).text();
      expect(body).toContain("no availability guarantee");
      // No invitation to argue: there is no undertaking here to keep serving
      // anyone, and asking people to come and negotiate would imply one.
      expect(body).not.toMatch(/issues|contact|tell us|get in touch/i);
    }
  });

  it("is never cached, so a limit lifts as soon as it lifts", () => {
    expect(refusal("rate").headers.get("Cache-Control")).toBe("no-store");
  });
});

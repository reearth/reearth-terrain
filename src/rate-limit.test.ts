import { beforeEach, describe, expect, it, vi } from "vitest";

import { OFF, type Policy } from "./policy.js";
import {
  __resetTracks,
  clientsOn,
  cellOf,
  checkRateLimit,
  clientKey,
  noteAsk,
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

describe("noteAsk", () => {
  const sweeping = policy({ crawl: "enforce", crawlCells: 64 });

  it("leaves a viewport alone, however many tiles it loads", () => {
    // A screenful at z14 is hundreds of tiles, all inside one or two z8
    // cells. Breadth is what separates it from a sweep, not volume.
    let last;
    for (let i = 0; i < 600; i++) {
      last = noteAsk(
        "viewer",
        [cellOf(14, 14549 + (i % 30), 6450 + Math.floor(i / 30))],
        1,
        sweeping,
      );
    }
    expect(last!.asks).toBe(600);
    expect(last!.cells).toBeLessThan(64);
    expect(last!.decision).toBe("allow");
  });

  it("catches a client walking across the world", () => {
    let last;
    for (let i = 0; i < 400; i++) {
      last = noteAsk("sweeper", [cellOf(14, i * 256, 6450)], 1, sweeping);
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
      last = noteAsk("shuffled", [cellOf(14, rnd(), rnd() % 16000)], 1, sweeping);
    }
    expect(last!.decision).toBe("refuse");
  });

  it("needs volume as well as breadth", () => {
    // Someone opening a world map briefly touches many cells. Too few
    // requests to be a sweep.
    let last;
    for (let i = 0; i < 100; i++) {
      last = noteAsk("browser", [cellOf(14, i * 256, 6450)], 1, sweeping);
    }
    expect(last!.cells).toBeGreaterThanOrEqual(64);
    expect(last!.decision).toBe("allow");
  });

  it("only writes it down when observing", () => {
    const p = policy({ crawl: "observe", crawlCells: 64 });
    let last;
    for (let i = 0; i < 400; i++) last = noteAsk("obs", [cellOf(14, i * 256, 6450)], 1, p);
    expect(last!.decision).toBe("observed");
  });

  it("forgets a client once its minute is over", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 400; i++) {
      noteAsk("slow", [cellOf(14, i * 256, 6450)], 1, sweeping, t0);
    }
    const after = noteAsk("slow", [cellOf(14, 0, 6450)], 1, sweeping, t0 + 61_000);
    expect(after.asks).toBe(1);
    expect(after.decision).toBe("allow");
  });

  it("does nothing at all when crawl detection is off", () => {
    let last;
    for (let i = 0; i < 400; i++) last = noteAsk("off", [cellOf(14, i * 256, 6450)], 1, policy());
    expect(last!.decision).toBe("allow");
    expect(last!.asks).toBe(0);
  });

  it("counts every cell a single wide request touches", () => {
    // A /heights.json request carries up to 256 points and was measured
    // spanning a median of 17 cells. Four of those reach the threshold; under
    // the old shape, which read only the first point, forty would not have.
    const wide = Array.from({ length: 17 }, (_, i) => cellOf(14, i * 256, 6450));
    let last;
    for (let i = 0; i < 4; i++) last = noteAsk("heights", wide, 64, sweeping);
    expect(last!.cells).toBe(17);
    expect(last!.asks).toBe(256);
    expect(last!.decision).toBe("allow"); // 17 cells is not yet a sweep

    const wider = Array.from({ length: 64 }, (_, i) => cellOf(14, 5000 + i * 256, 3000));
    last = noteAsk("heights", wider, 64, sweeping);
    expect(last!.cells).toBeGreaterThanOrEqual(64);
    expect(last!.decision).toBe("refuse");
  });

  it("counts points rather than requests, so routes are comparable", () => {
    // One 200-point request costs the service what 200 tile requests cost, so
    // it counts the same against the volume half of the rule.
    const cells = Array.from({ length: 70 }, (_, i) => cellOf(14, i * 256, 6450));
    const one = noteAsk("bulk", cells, 200, sweeping);
    expect(one.asks).toBe(200);
    expect(one.decision).toBe("refuse");
  });

  it("leaves an allowed client unwatched", () => {
    const p = policy({ crawl: "enforce", crawlCells: 64, allow: ["https://ours.example"] });
    const key = clientKey(request("192.0.2.1"), "https://ours.example");
    let last;
    for (let i = 0; i < 400; i++) last = noteAsk(key, [cellOf(14, i * 256, 6450)], 1, p);
    expect(last!.decision).toBe("allow");
  });
});

describe("clientsOn", () => {
  const watching = policy({ crawl: "observe", crawlCells: 64 });

  it("counts the distinct clients seen on one origin", () => {
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      noteAsk(`${ip}|http://localhost:1234`, [cellOf(14, 1, 1)], 1, watching);
    }
    noteAsk("198.51.100.7|https://example.com", [cellOf(14, 1, 1)], 1, watching);

    expect(clientsOn("http://localhost:1234")).toBe(3);
    expect(clientsOn("https://example.com")).toBe(1);
    expect(clientsOn("https://nobody.example")).toBe(0);
  });

  it("does not confuse one origin with another that extends it", () => {
    noteAsk("192.0.2.1|http://localhost:1234", [cellOf(14, 1, 1)], 1, watching);
    noteAsk("192.0.2.1|http://localhost:12340", [cellOf(14, 1, 1)], 1, watching);
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

  it("points at the repository, which is the way out with no limits in it", async () => {
    for (const reason of ["rate", "sweep"] as const) {
      const body = await refusal(reason).text();
      expect(body).toContain("github.com/reearth/reearth-terrain");
      expect(body).toContain("open source");
      expect(body).toContain("Cloudflare account");
    }
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

// Who is allowed to ask for a lot, and who is walking the grid.
//
// Two different abusers, so two different tools.
//
// The first is volume: one client asking for far more than a map view needs.
// On 2026-09-14 two origins — both local dev servers, reached over the public
// internet — accounted for 83% of Terrain's attributed demand, about 90
// requests a second each, unbroken for hours, asking for the same tile 11.5
// times on average. That is an application with a broken cache, not a crawl,
// and `checkRateLimit` is what meets it.
//
// The second is breadth: a client sweeping the tile grid to collect it. That
// one may be perfectly slow and still cost a great deal, because every tile
// it touches is generated for it alone and cached for nobody. `noteTile` is
// what meets that, and the answer it earns says where to get the source data
// instead — faster for them, cheaper for us.
//
// The rules are not here: they are in KV, via src/policy.ts. This file only
// applies them.

import type { Mode, Policy } from "./policy.js";

/** What to do with a request. */
export type Decision = "allow" | "observed" | "refuse";

export interface LimiterEnv {
  /**
   * Workers' rate limiting binding. Counting is per Cloudflare location,
   * which suits the shape of the problem: a single runaway instance sits on
   * one location and is caught there, while the many well-behaved dev servers
   * are spread over the world and each counts on its own.
   *
   * Absent in tests and in `wrangler dev`, which means "allow".
   */
  TILE_RATE_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/**
 * How the client is counted: its address and the site it says it is on.
 *
 * Both parts matter. Address alone would put a university behind one NAT on a
 * single budget; origin alone would put every `http://localhost:4173` in the
 * world on one, and there are 155 of those, nearly all of them innocent.
 */
export function clientKey(request: Request, origin: string): string {
  return `${request.headers.get("CF-Connecting-IP") ?? ""}|${origin}`;
}

function listed(entries: string[], key: string): boolean {
  const [ip = "", origin = ""] = key.split("|");
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === ip || entry === origin) return true;
    if (entry.endsWith("*") && origin.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

function appliesTo(origin: string, prefixes: string[]): boolean {
  return prefixes.some((p) => p && origin.startsWith(p));
}

function verdict(setting: Mode): Decision {
  return setting === "enforce" ? "refuse" : "observed";
}

/** Ask whether this client has had its share of the minute. */
export async function checkRateLimit(
  key: string,
  origin: string,
  policy: Policy,
  env: LimiterEnv,
): Promise<Decision> {
  if (listed(policy.deny, key)) return "refuse";
  if (listed(policy.allow, key)) return "allow";
  if (policy.rateLimit === "off") return "allow";
  if (!appliesTo(origin, policy.origins)) return "allow";
  if (!env.TILE_RATE_LIMIT) return "allow";

  const { success } = await env.TILE_RATE_LIMIT.limit({ key });
  return success ? "allow" : verdict(policy.rateLimit);
}

// ---------------------------------------------------------------------------
// Sweep detection
// ---------------------------------------------------------------------------

/** How long a client's recent movement is remembered. */
const WINDOW_MS = 60_000;
/** Clients tracked at once, per isolate. Oldest goes first. */
const CLIENTS = 1000;
/** Cells remembered per client. Past this we already know the answer. */
const CELLS_PER_CLIENT = 256;
/** Requests below which breadth means nothing — a first page load is wide. */
const MIN_REQUESTS = 200;

interface Track {
  cells: Set<string>;
  requests: number;
  since: number;
}

const tracks = new Map<string, Track>();

/**
 * Reduce a tile to the z8 cell holding it. Someone reading a map stays within
 * a handful of these however far they pan in a minute — z8 is roughly 150 km
 * across. A sweep passes through hundreds.
 *
 * Deliberately not "are these tiles consecutive". A viewport is also a run of
 * consecutive tiles — thirty across, then the next row — so telling a
 * 600-tile screen from a sweep by run length is guesswork. Breadth is what
 * actually differs, and it catches a sweep taken in random order too.
 */
export function cellOf(z: number, x: number, y: number): string {
  if (z <= 8) return `${z}/${x}/${y}`;
  const shift = z - 8;
  return `8/${x >> shift}/${y >> shift}`;
}

export interface Sweep {
  cells: number;
  requests: number;
  decision: Decision;
}

/** Record one tile for this client, and say whether this looks like a sweep. */
export function noteTile(
  key: string,
  cell: string,
  policy: Policy,
  now = Date.now(),
): Sweep {
  if (policy.crawl === "off") return { cells: 0, requests: 0, decision: "allow" };
  if (listed(policy.allow, key)) return { cells: 0, requests: 0, decision: "allow" };

  let track = tracks.get(key);
  if (!track || now - track.since > WINDOW_MS) {
    track = { cells: new Set(), requests: 0, since: now };
  } else {
    tracks.delete(key); // re-inserted below, which promotes it to most recent
  }
  track.requests++;
  if (track.cells.size < CELLS_PER_CLIENT) track.cells.add(cell);
  tracks.set(key, track);

  while (tracks.size > CLIENTS) {
    const oldest = tracks.keys().next();
    if (oldest.done) break;
    tracks.delete(oldest.value);
  }

  const sweeping =
    track.requests >= MIN_REQUESTS && track.cells.size >= policy.crawlCells;
  return {
    cells: track.cells.size,
    requests: track.requests,
    decision: sweeping ? verdict(policy.crawl) : "allow",
  };
}

/**
 * How many distinct clients this isolate has seen on one origin lately.
 *
 * Two origins account for most of Terrain's demand, and what to do about them
 * depends entirely on whether each is one runaway instance or a crowd of
 * people running the same application — a limit meets the first and does
 * nothing about the second. `http://127.0.0.1:42003` is a port an operating
 * system handed out, so a crowd is perfectly possible.
 *
 * A count answers that without putting an identifier in the log. It reads
 * only what this isolate holds, so it is a floor, not a total: seeing thirty
 * settles the question, seeing one does not.
 */
export function clientsOn(origin: string): number {
  const suffix = `|${origin}`;
  let n = 0;
  for (const key of tracks.keys()) if (key.endsWith(suffix)) n++;
  return n;
}

/** Test-only: forget every tracked client. */
export function __resetTracks(): void {
  tracks.clear();
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

const SOURCES = [
  "  DEM    https://tiles.mapterhorn.com   (Mapterhorn, PMTiles)",
  "  Geoid  EGM2008 2.5-arcminute grid     (public domain)",
].join("\n");

const ISSUES = "https://github.com/reearth/reearth-terrain/issues";

/**
 * Say no, and say what to do instead.
 *
 * Someone collecting the whole grid wants the data, not this service: the
 * source is one download, already assembled, and theirs to keep. Tiles here
 * are built one at a time when asked for, and a sweep leaves behind a cache
 * nobody will ever read. Telling them that is more likely to end the traffic
 * than a bare 429, and it is the more useful answer besides.
 */
export function refusal(reason: "rate" | "sweep"): Response {
  const body =
    reason === "sweep"
      ? `This looks like a systematic sweep of the tile grid.

Every tile here is built when somebody asks for it, so walking the grid
is slow for you and expensive for us. If you want the data, take the
source instead — it downloads faster and it is yours to keep:

${SOURCES}

If this was not a sweep, we would rather fix our detection than get in
your way: ${ISSUES}
`
      : `Too many requests from this client.

This service is free and we would like to keep it that way, which means
no one client can take an unbounded share of it. If you are running a
map, an ordinary browser cache is usually enough to stay well under the
limit. If you need the data in bulk, take the source instead:

${SOURCES}

If this limit is in your way, tell us what you are building: ${ISSUES}
`;

  return new Response(body, {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "60",
      "Cache-Control": "no-store",
    },
  });
}

// Who gets served, and how much — kept out of the repository.
//
// This repository is public, so the policy lives in KV rather than in
// `wrangler.toml`. Thresholds are only numbers and could sit in either, but
// an exception written for one client is an address, and an address is
// somebody's. KV is private, and it changes without a deploy, which matters
// for a policy whose whole purpose is to be adjusted once we have watched it
// run.
//
// The document is read once per isolate per minute, not once per request: a
// KV read on the hot path would cost more than the limit saves. The read goes
// through `shared` for the reason src/single-flight.ts describes.
//
// Defaults refuse nothing. An empty namespace, an unparseable document, or a
// KV outage all leave the service exactly as it was before any of this
// existed, which is the right way round for a mechanism that turns people
// away.

import { READ_TIMEOUT_MS, shared } from "./single-flight.js";

export type Mode = "off" | "observe" | "enforce";

export interface Policy {
  /** Volume limiting, for a client asking far more than a map view needs. */
  rateLimit: Mode;
  /** Origin prefixes the volume limit applies to. Empty applies to none. */
  origins: string[];
  /** Sweep detection, for a client collecting the grid. */
  crawl: Mode;
  /** Distinct z8 cells within a minute that count as a sweep. */
  crawlCells: number;
  /** Client addresses or origins that are never limited. */
  allow: string[];
  /** Client addresses or origins that are always refused. */
  deny: string[];
}

export const OFF: Policy = {
  rateLimit: "off",
  origins: [],
  crawl: "off",
  crawlCells: 64,
  allow: [],
  deny: [],
};

const KEY = "policy";
const TTL_MS = 60_000;

interface Cached {
  value: Policy;
  expires: number;
}

let current: Cached | null = null;
const loading = new Map<string, Promise<Policy>>();

export interface PolicyEnv {
  CONFIG?: KVNamespace;
}

/** The policy in force, from KV, memoized for a minute per isolate. */
export async function loadPolicy(env: PolicyEnv, now = Date.now()): Promise<Policy> {
  if (current && current.expires > now) return current.value;
  if (!env.CONFIG) return OFF;

  try {
    const value = await shared(
      loading,
      KEY,
      async () => parse(await env.CONFIG!.get(KEY, "json")),
      { timeoutMs: READ_TIMEOUT_MS, keepResolved: false },
    );
    current = { value, expires: now + TTL_MS };
    return value;
  } catch (err) {
    // Serve the last good policy if we have one, and otherwise serve
    // everybody. Being unable to read the rules is not a reason to refuse.
    console.warn("policy: read failed", { error: String(err) });
    return current?.value ?? OFF;
  }
}

/** Test-only: forget the memoized policy. */
export function __resetPolicy(): void {
  current = null;
  loading.clear();
}

function parse(raw: unknown): Policy {
  if (!raw || typeof raw !== "object") return OFF;
  const doc = raw as Record<string, unknown>;
  return {
    rateLimit: mode(doc.rateLimit),
    origins: strings(doc.origins),
    crawl: mode(doc.crawl),
    crawlCells: positive(doc.crawlCells, OFF.crawlCells),
    allow: strings(doc.allow),
    deny: strings(doc.deny),
  };
}

function mode(value: unknown): Mode {
  return value === "observe" || value === "enforce" ? value : "off";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v !== "");
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

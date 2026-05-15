import { describe, expect, it } from "vitest";
import { bodyEtag, matchesIfNoneMatch } from "./cache.js";

describe("bodyEtag", () => {
  it("is a strong, double-quoted hex ETag", () => {
    // Format: "<16 lowercase hex chars>"  (8-byte SHA-256 prefix)
    return bodyEtag("hello").then((e) => {
      expect(e).toMatch(/^"[0-9a-f]{16}"$/);
    });
  });

  it("is stable across calls", async () => {
    const [a, b] = await Promise.all([bodyEtag("hello"), bodyEtag("hello")]);
    expect(a).toBe(b);
  });

  it("changes when the body changes", async () => {
    const [a, b] = await Promise.all([bodyEtag("hello"), bodyEtag("Hello")]);
    expect(a).not.toBe(b);
  });
});

describe("matchesIfNoneMatch", () => {
  const weak = 'W/"deadbeefdeadbeef"';
  const strong = '"deadbeefdeadbeef"';

  it("returns false for a missing header", () => {
    expect(matchesIfNoneMatch(null, weak)).toBe(false);
    expect(matchesIfNoneMatch("", weak)).toBe(false);
  });

  it("treats * as a wildcard match", () => {
    expect(matchesIfNoneMatch("*", weak)).toBe(true);
    expect(matchesIfNoneMatch("  *  ", weak)).toBe(true);
  });

  it("uses weak comparison (W/ prefix on either side is ignored)", () => {
    expect(matchesIfNoneMatch(weak, weak)).toBe(true);
    expect(matchesIfNoneMatch(strong, weak)).toBe(true);
    expect(matchesIfNoneMatch(weak, strong)).toBe(true);
  });

  it("matches one entry in a comma-separated list", () => {
    const header = `"deadbeef00000000", ${weak}, "cafebabecafebabe"`;
    expect(matchesIfNoneMatch(header, weak)).toBe(true);
  });

  it("returns false when no token matches", () => {
    expect(matchesIfNoneMatch('"otherother000000"', weak)).toBe(false);
  });
});

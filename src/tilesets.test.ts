import { describe, expect, it } from "vitest";
import {
  DEFAULT_TILESET,
  resolveTileset,
  resolveTilesetVersion,
  TILESETS,
  type Tileset,
} from "./tilesets.js";

describe("resolveTileset", () => {
  it("resolves a known tileset name", () => {
    const t = resolveTileset(DEFAULT_TILESET);
    expect(t).not.toBeNull();
    expect(t?.name).toBe(DEFAULT_TILESET);
  });

  it("falls back to the default when the name is undefined", () => {
    const t = resolveTileset(undefined);
    expect(t?.name).toBe(DEFAULT_TILESET);
  });

  it("returns null for an unknown name", () => {
    expect(resolveTileset("does-not-exist")).toBeNull();
  });
});

describe("default tileset config", () => {
  it("declares a valid zoom range and required fields", () => {
    const t = TILESETS[DEFAULT_TILESET]!;
    expect(t.minZoom).toBeLessThanOrEqual(t.maxZoom);
    expect(t.minZoom).toBeGreaterThanOrEqual(0);
    expect(t.geoidKey.length).toBeGreaterThan(0);
    expect(t.attribution.length).toBeGreaterThan(0);
    expect(t.version.length).toBeGreaterThan(0);
  });
});

describe("resolveTilesetVersion", () => {
  // Build a minimal Tileset stub — only the fields the resolver reads.
  const stub = (over: Partial<Tileset>): Tileset =>
    ({
      name: "x",
      version: "4",
      description: "",
      attribution: [],
      dem: { name: "stub", read: async () => null },
      geoidKey: "k",
      minZoom: 0,
      maxZoom: 0,
      ...over,
    }) as Tileset;

  it("returns the bare version when no geoid revision is configured", () => {
    expect(resolveTilesetVersion(stub({ version: "4" }))).toBe("4");
  });

  it("appends -g{geoidVersion} when the geoid is independently revised", () => {
    expect(resolveTilesetVersion(stub({ version: "4", geoidVersion: "2" }))).toBe("4-g2");
  });

  it("keeps existing v4/ cache prefixes valid for the default tileset (no geoid bump in flight)", () => {
    // Regression guard: introducing the geoidVersion field must NOT
    // implicitly add a suffix to the default tileset, or every existing
    // cached entry under cache/terrain/{name}/v4/ would become orphaned.
    const t = TILESETS[DEFAULT_TILESET]!;
    expect(resolveTilesetVersion(t)).toBe(t.version);
  });
});

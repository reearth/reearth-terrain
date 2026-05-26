import { describe, expect, it } from "vitest";
import { MAX_POINTS_PER_REQUEST, parsePointsParam } from "./sample.js";

describe("parsePointsParam", () => {
  it("parses a single lon,lat pair", () => {
    expect(parsePointsParam("139.7,35.7")).toEqual([{ lon: 139.7, lat: 35.7 }]);
  });

  it("parses multiple points separated by semicolons", () => {
    expect(parsePointsParam("0,0;139.7,35.7;-122.4,37.8")).toEqual([
      { lon: 0, lat: 0 },
      { lon: 139.7, lat: 35.7 },
      { lon: -122.4, lat: 37.8 },
    ]);
  });

  it("tolerates whitespace and trailing separators", () => {
    expect(parsePointsParam(" 1 , 2 ; ; 3,4 ; ")).toEqual([
      { lon: 1, lat: 2 },
      { lon: 3, lat: 4 },
    ]);
  });

  it("returns an empty array for an empty / whitespace-only input", () => {
    expect(parsePointsParam("")).toEqual([]);
    expect(parsePointsParam("  ;;  ")).toEqual([]);
  });

  it("rejects entries that aren't exactly lon,lat", () => {
    expect(() => parsePointsParam("1")).toThrow(/expected "lon,lat"/);
    expect(() => parsePointsParam("1,2,3")).toThrow(/expected "lon,lat"/);
  });

  it("rejects non-numeric components", () => {
    expect(() => parsePointsParam("abc,2")).toThrow(/non-numeric/);
    expect(() => parsePointsParam("1,xyz")).toThrow(/non-numeric/);
  });

  it("rejects out-of-range latitudes", () => {
    expect(() => parsePointsParam("0,91")).toThrow(/latitude out of range/);
    expect(() => parsePointsParam("0,-90.5")).toThrow(/latitude out of range/);
  });

  it("accepts longitudes outside [-180,180] (callers expect normalization downstream)", () => {
    // Antimeridian wraparound is normalized at sampling time, so parsing
    // shouldn't be the gate that rejects e.g. lon=-181 from a panning UI.
    expect(parsePointsParam("-181,0;540,0")).toEqual([
      { lon: -181, lat: 0 },
      { lon: 540, lat: 0 },
    ]);
  });
});

describe("MAX_POINTS_PER_REQUEST", () => {
  it("is exposed and is a positive integer", () => {
    expect(MAX_POINTS_PER_REQUEST).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_POINTS_PER_REQUEST)).toBe(true);
  });
});

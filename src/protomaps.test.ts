import { describe, expect, it } from "vitest";
import { pmtilesUrlForDate } from "./protomaps.js";

describe("pmtilesUrlForDate", () => {
  it("builds an upstream URL for a YYYYMMDD date", () => {
    expect(pmtilesUrlForDate("20260101")).toBe(
      "https://build.protomaps.com/20260101.pmtiles",
    );
  });

  it("does not validate the date string (caller responsibility)", () => {
    // We don't want this helper to throw — `currentPmtilesDate` is the
    // gatekeeper that probes for an existing build.
    expect(() => pmtilesUrlForDate("anything")).not.toThrow();
  });
});

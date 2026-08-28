import { describe, expect, it } from "vitest";
import { normalizeLabels, parseTrackerTimestamp } from "./normalization.js";

describe("normalizeLabels", () => {
  it("trims, lowercases, drops blanks, and deduplicates labels", () => {
    expect(
      normalizeLabels([" Alpha ", "BETA", "alpha", "", "  ", 1, null])
    ).toEqual(["alpha", "beta"]);
  });
});

describe("parseTrackerTimestamp", () => {
  it("returns a canonical ISO string for RFC 3339 input", () => {
    expect(parseTrackerTimestamp("2026-08-28T12:34:56+09:00")).toBe(
      "2026-08-28T03:34:56.000Z"
    );
  });

  it.each([
    "",
    "2026-08-28",
    "not-a-timestamp",
    "2026-02-30T12:00:00Z",
    0,
    null,
  ])("returns null for invalid tracker timestamp %j", (value) => {
    expect(parseTrackerTimestamp(value)).toBeNull();
  });
});

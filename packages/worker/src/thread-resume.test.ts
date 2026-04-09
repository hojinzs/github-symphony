import { describe, expect, it } from "vitest";
import {
  buildContinuationTurnInput,
  DEFAULT_CONTINUATION_GUIDANCE,
  parseNonNegativeInteger,
} from "./thread-resume.js";

describe("parseNonNegativeInteger", () => {
  it("returns zero for missing or invalid values", () => {
    expect(parseNonNegativeInteger(undefined)).toBe(0);
    expect(parseNonNegativeInteger(null)).toBe(0);
    expect(parseNonNegativeInteger("")).toBe(0);
    expect(parseNonNegativeInteger("-4")).toBe(0);
    expect(parseNonNegativeInteger("abc")).toBe(0);
  });

  it("normalizes positive values", () => {
    expect(parseNonNegativeInteger("7")).toBe(7);
    expect(parseNonNegativeInteger(3.8)).toBe(3);
  });
});

describe("buildContinuationTurnInput", () => {
  it("falls back to the default continuation guidance", () => {
    expect(buildContinuationTurnInput({})).toBe(
      DEFAULT_CONTINUATION_GUIDANCE
    );
  });

  it("renders continuation template variables for resume-aware prompts", () => {
    expect(
      buildContinuationTurnInput({
        continuationGuidance:
          "Continue after {{cumulativeTurnCount}} turns. Summary: {{lastTurnSummary}}",
        cumulativeTurnCount: 6,
        lastTurnSummary: "worker resumed the same issue thread",
      })
    ).toBe(
      "Continue after 6 turns. Summary: worker resumed the same issue thread"
    );
  });

  it("rejects unsupported Liquid syntax in continuation guidance", () => {
    expect(() =>
      buildContinuationTurnInput({
        continuationGuidance: "{% if cumulativeTurnCount %}resume{% endif %}",
        cumulativeTurnCount: 6,
        lastTurnSummary: "worker resumed the same issue thread",
      })
    ).toThrow("continuation guidance does not support Liquid tags");
  });
});

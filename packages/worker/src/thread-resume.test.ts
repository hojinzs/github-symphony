import { describe, expect, it } from "vitest";
import {
  buildContinuationTurnInput,
  buildInitialTurnInput,
  DEFAULT_CONTINUATION_GUIDANCE,
  parseNonNegativeInteger,
  resolveRemainingTurns,
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

describe("resolveRemainingTurns", () => {
  it("subtracts cumulative turns from the global max", () => {
    expect(resolveRemainingTurns(20, 3)).toBe(17);
  });

  it("does not allow negative remaining turns", () => {
    expect(resolveRemainingTurns(2, 5)).toBe(0);
  });
});

describe("buildInitialTurnInput", () => {
  it("keeps the original prompt for fresh sessions", () => {
    expect(
      buildInitialTurnInput({
        renderedPrompt: "original prompt",
        mode: "fresh",
      })
    ).toBe("original prompt");
  });

  it("builds a concise continuation prompt for hard resume", () => {
    const prompt = buildInitialTurnInput({
      renderedPrompt: "original prompt",
      mode: "resume",
      lastTurnSummary: "Finished the parser update.",
      cumulativeTurnCount: 4,
      continuationGuidance:
        "Continue from turn {{cumulativeTurnCount}} with {{lastTurnSummary}}",
    });

    expect(prompt).toContain("existing thread context");
    expect(prompt).toContain("Previous worker turns completed: 4.");
    expect(prompt).toContain("Finished the parser update.");
    expect(prompt).toContain(
      "Continue from turn 4 with Finished the parser update."
    );
  });

  it("embeds the last turn summary for soft resume", () => {
    const prompt = buildInitialTurnInput({
      renderedPrompt: "original prompt",
      mode: "soft-resume",
      lastTurnSummary: "Implemented the env passthrough.",
      cumulativeTurnCount: 3,
      continuationGuidance:
        "Use summary {{lastTurnSummary}} after {{cumulativeTurnCount}} turns.",
    });

    expect(prompt).toContain("Original issue instructions:");
    expect(prompt).toContain("Implemented the env passthrough.");
    expect(prompt).toContain(
      "Use summary Implemented the env passthrough. after 3 turns."
    );
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
});

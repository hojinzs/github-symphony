import { describe, expect, it } from "vitest";
import {
  buildInitialTurnInput,
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
    expect(
      buildInitialTurnInput({
        renderedPrompt: "original prompt",
        mode: "resume",
      })
    ).toContain("existing thread context");
  });

  it("embeds the last turn summary for soft resume", () => {
    const prompt = buildInitialTurnInput({
      renderedPrompt: "original prompt",
      mode: "soft-resume",
      lastTurnSummary: "Implemented the env passthrough.",
    });

    expect(prompt).toContain("Original issue instructions:");
    expect(prompt).toContain("Implemented the env passthrough.");
    expect(prompt).toContain("carry-over context");
  });
});

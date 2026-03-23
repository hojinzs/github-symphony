import { describe, expect, it } from "vitest";
import { classifySessionExit } from "./exit-classification.js";

describe("classifySessionExit", () => {
  it("classifies user input as user-input-required", () => {
    expect(
      classifySessionExit({
        runPhase: "failed",
        userInputRequired: true,
        maxTurnsReached: false,
      })
    ).toBe("user-input-required");
  });

  it("classifies timed out and stalled phases as timeout", () => {
    expect(
      classifySessionExit({
        runPhase: "timed_out",
        userInputRequired: false,
        maxTurnsReached: false,
      })
    ).toBe("timeout");
    expect(
      classifySessionExit({
        runPhase: "stalled",
        userInputRequired: false,
        maxTurnsReached: false,
      })
    ).toBe("timeout");
  });

  it("classifies max-turn exits distinctly from success", () => {
    expect(
      classifySessionExit({
        runPhase: "succeeded",
        userInputRequired: false,
        maxTurnsReached: true,
      })
    ).toBe("max-turns-reached");
  });

  it("classifies succeeded runs as completed", () => {
    expect(
      classifySessionExit({
        runPhase: "succeeded",
        userInputRequired: false,
        maxTurnsReached: false,
      })
    ).toBe("completed");
  });

  it("falls back to error for other terminal failures", () => {
    expect(
      classifySessionExit({
        runPhase: "failed",
        userInputRequired: false,
        maxTurnsReached: false,
      })
    ).toBe("error");
  });
});

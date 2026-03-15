import { describe, expect, it } from "vitest";
import {
  resolveFinalExecutionPhase,
  resolveInitialExecutionPhase,
  resolvePausedExecutionPhase,
} from "./execution-phase.js";

describe("execution phase helpers", () => {
  it("maps blocker-check states to planning", () => {
    expect(
      resolveInitialExecutionPhase({
        issueState: "Todo",
        blockerCheckStates: ["Todo"],
        activeStates: ["Todo", "In Progress"],
      })
    ).toBe("planning");
  });

  it("maps active issue states to implementation", () => {
    expect(
      resolveInitialExecutionPhase({
        issueState: "In Progress",
        blockerCheckStates: ["Todo"],
        activeStates: ["Todo", "In Progress"],
      })
    ).toBe("implementation");
  });

  it("advances paused phases when the issue becomes non-actionable", () => {
    expect(resolvePausedExecutionPhase("planning")).toBe("human-review");
    expect(resolvePausedExecutionPhase("implementation")).toBe(
      "awaiting-merge"
    );
  });

  it("does not force completed when the tracker still reports active work", () => {
    expect(
      resolveFinalExecutionPhase({
        currentPhase: "implementation",
        trackerState: "active",
        userInputRequired: false,
      })
    ).toBe("implementation");
    expect(
      resolveFinalExecutionPhase({
        currentPhase: "implementation",
        trackerState: "unknown",
        userInputRequired: false,
      })
    ).toBe("implementation");
  });
});

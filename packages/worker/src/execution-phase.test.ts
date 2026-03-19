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

describe("PR review lifecycle phase transitions", () => {
  const blockerCheckStates = ["Ready"];
  const activeStates = ["Ready", "In Progress"];

  it("issue in Ready state starts in planning phase", () => {
    expect(
      resolveInitialExecutionPhase({
        issueState: "Ready",
        blockerCheckStates,
        activeStates,
      })
    ).toBe("planning");
  });

  it("issue in In Progress state starts in implementation phase", () => {
    expect(
      resolveInitialExecutionPhase({
        issueState: "In Progress",
        blockerCheckStates,
        activeStates,
      })
    ).toBe("implementation");
  });

  it("planning pauses to human-review when tracker becomes non-actionable", () => {
    expect(
      resolveFinalExecutionPhase({
        currentPhase: "planning",
        trackerState: "non-actionable",
        userInputRequired: false,
      })
    ).toBe("human-review");
  });

  it("implementation pauses to awaiting-merge when tracker becomes non-actionable", () => {
    expect(
      resolveFinalExecutionPhase({
        currentPhase: "implementation",
        trackerState: "non-actionable",
        userInputRequired: false,
      })
    ).toBe("awaiting-merge");
  });

  it("planning stays in planning when user input is required", () => {
    expect(
      resolveFinalExecutionPhase({
        currentPhase: "planning",
        trackerState: "non-actionable",
        userInputRequired: true,
      })
    ).toBe("planning");
  });

  it("non-active issue state returns null (not dispatchable)", () => {
    expect(
      resolveInitialExecutionPhase({
        issueState: "Done",
        blockerCheckStates,
        activeStates,
      })
    ).toBeNull();
  });

  it("null issue state returns null", () => {
    expect(
      resolveInitialExecutionPhase({
        issueState: null,
        blockerCheckStates,
        activeStates,
      })
    ).toBeNull();
  });

  it("completed and human-review phases do not advance further", () => {
    expect(resolvePausedExecutionPhase("completed")).toBeNull();
    expect(resolvePausedExecutionPhase("human-review")).toBeNull();
    expect(resolvePausedExecutionPhase("awaiting-merge")).toBeNull();
  });
});

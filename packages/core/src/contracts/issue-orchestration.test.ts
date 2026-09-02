import { describe, expect, it } from "vitest";
import {
  assertIssueOrchestrationTransition,
  isFailureRetryRearmedForState,
  isFailureRetrySuppressedForState,
  ISSUE_ORCHESTRATION_INITIAL_STATES,
  ISSUE_ORCHESTRATION_TRANSITIONS,
  type IssueOrchestrationState,
} from "./issue-orchestration.js";

const exhaustedIssueRecord = {
  issueId: "issue-1",
  identifier: "acme/repo#1",
  workspaceKey: "acme_repo_1",
  completedOnce: false,
  failureRetryCount: 3,
  state: "released" as const,
  currentRunId: null,
  retryEntry: null,
  updatedAt: "2026-09-02T00:00:00.000Z",
};

describe("issue orchestration transitions", () => {
  it("accepts every declared transition", () => {
    for (const [from, targets] of Object.entries(
      ISSUE_ORCHESTRATION_TRANSITIONS
    ) as [IssueOrchestrationState, readonly IssueOrchestrationState[]][]) {
      for (const to of targets) {
        expect(() =>
          assertIssueOrchestrationTransition(from, to)
        ).not.toThrow();
      }
    }
  });

  it.each<[IssueOrchestrationState, IssueOrchestrationState]>([
    ["unclaimed", "released"],
    ["released", "retry_queued"],
    ["running", "claimed"],
    ["retry_queued", "claimed"],
    ["released", "running"],
  ])("rejects invalid transition %s -> %s", (from, to) => {
    expect(() => assertIssueOrchestrationTransition(from, to)).toThrow(
      `Invalid issue orchestration transition: ${from} -> ${to}`
    );
  });

  it.each(ISSUE_ORCHESTRATION_INITIAL_STATES)(
    "accepts %s when establishing a record",
    (to) => {
      expect(() => assertIssueOrchestrationTransition(null, to)).not.toThrow();
    }
  );

  it("rejects an invalid initial state", () => {
    expect(() => assertIssueOrchestrationTransition(null, "released")).toThrow(
      "Invalid initial issue orchestration state: released"
    );
  });

  it("reports an unknown persisted state explicitly", () => {
    expect(() =>
      assertIssueOrchestrationTransition(
        "unknown" as IssueOrchestrationState,
        "running"
      )
    ).toThrow("Unknown issue orchestration state: unknown");
  });

  it("treats a legacy missing suppression state as re-armable", () => {
    expect(isFailureRetrySuppressedForState(exhaustedIssueRecord, "Todo")).toBe(
      false
    );
    expect(isFailureRetryRearmedForState(exhaustedIssueRecord, "Todo")).toBe(
      true
    );
  });

  it("keeps a recorded suppression state blocked until it changes", () => {
    const record = {
      ...exhaustedIssueRecord,
      failureRetrySuppressedState: "Todo",
    };

    expect(isFailureRetrySuppressedForState(record, "Todo")).toBe(true);
    expect(isFailureRetryRearmedForState(record, "Todo")).toBe(false);
    expect(isFailureRetryRearmedForState(record, "In progress")).toBe(true);
  });
});

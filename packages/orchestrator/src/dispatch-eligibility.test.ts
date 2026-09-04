import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type OrchestratorRunRecord,
  type TrackedIssue,
} from "@gh-symphony/core";
import {
  DEFAULT_CONVERGENCE_LOCK_TTL_MS,
  getConvergenceLockStatus,
  isActiveRunRecordStatus,
  isIssueCandidateEligibleWithReason,
  isIssueOrchestrationClaimedState,
  resolveConvergenceLockTtlMs,
} from "./dispatch-eligibility.js";

function convergenceRun(completedAt: string): OrchestratorRunRecord {
  return {
    runId: "run-convergence",
    projectId: "project-1",
    projectSlug: "project-1",
    issueId: "issue-1",
    issueSubjectId: "issue-1",
    issueIdentifier: "acme/platform#1",
    issueState: "Todo",
    repository: { owner: "acme", name: "platform" },
    status: "failed",
    attempt: 1,
    processId: null,
    port: 4601,
    workingDirectory: "/tmp/platform",
    issueWorkspaceKey: "acme_platform_1",
    workspaceRuntimeDir: "/tmp/platform/runtime",
    workflowPath: null,
    retryKind: null,
    threadId: null,
    createdAt: completedAt,
    updatedAt: completedAt,
    startedAt: completedAt,
    completedAt,
    lastError: "convergence_detected: workspace unchanged",
    nextRetryAt: null,
    runPhase: "failed",
    runtimeSession: {
      sessionId: null,
      threadId: null,
      status: "completed",
      startedAt: completedAt,
      updatedAt: completedAt,
      exitClassification: "convergence-detected",
    },
  };
}

function candidate(overrides: Partial<TrackedIssue> = {}): TrackedIssue {
  return {
    id: "issue-1",
    identifier: "acme/platform#1",
    number: 1,
    title: "Candidate",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    dispatchable: true,
    assigneeId: null,
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner: "acme",
      name: "platform",
      cloneUrl: "https://github.com/acme/platform.git",
    },
    tracker: {
      adapter: "github-project",
      bindingId: "project-1",
      itemId: "item-1",
    },
    metadata: {},
    ...overrides,
  };
}

describe("dispatch candidate eligibility", () => {
  it("reports the first policy reason that prevents dispatch", () => {
    expect(
      isIssueCandidateEligibleWithReason(
        candidate({ dispatchable: false }),
        DEFAULT_WORKFLOW_LIFECYCLE
      )
    ).toEqual({ eligible: false, reason: "not_dispatchable" });
    expect(
      isIssueCandidateEligibleWithReason(
        candidate({ state: "Done" }),
        DEFAULT_WORKFLOW_LIFECYCLE
      )
    ).toEqual({ eligible: false, reason: "inactive_state" });
    expect(
      isIssueCandidateEligibleWithReason(
        candidate(),
        DEFAULT_WORKFLOW_LIFECYCLE
      )
    ).toEqual({ eligible: true, reason: null });
  });

  it("classifies only claimed orchestration and active run states as active", () => {
    expect(
      ["claimed", "running", "retry_queued"].map(
        isIssueOrchestrationClaimedState
      )
    ).toEqual([true, true, true]);
    expect(isIssueOrchestrationClaimedState("released")).toBe(false);
    expect(
      ["pending", "starting", "running", "retrying"].map(
        isActiveRunRecordStatus
      )
    ).toEqual([true, true, true, true]);
    expect(isActiveRunRecordStatus("completed")).toBe(false);
  });
});

describe("convergence lock policy", () => {
  it("releases an expired lock and reports expiry", () => {
    const run = convergenceRun("2026-08-05T00:00:00.000Z");

    expect(
      getConvergenceLockStatus(
        [run],
        "issue-1",
        "Todo",
        "2026-08-05T00:00:00.000Z",
        { now: new Date("2026-08-06T00:00:00.000Z"), ttlMs: 60_000 }
      )
    ).toEqual({ run, expired: true });
  });

  it("fails loudly when a lock timestamp cannot be parsed", () => {
    expect(() =>
      getConvergenceLockStatus(
        [convergenceRun("not-a-timestamp")],
        "issue-1",
        "Todo",
        "2026-08-05T00:00:00.000Z"
      )
    ).toThrow(/timestamp is invalid/);
  });

  it("keeps the lock when the tracker timestamp is absent", () => {
    const run = convergenceRun("2026-08-05T00:00:00.000Z");

    expect(
      getConvergenceLockStatus([run], "issue-1", "Todo", null, {
        now: new Date("2026-08-05T00:01:00.000Z"),
        ttlMs: 60 * 60 * 1000,
      })
    ).toEqual({ run, expired: false });
  });

  it("uses a bounded default TTL and accepts a positive override", () => {
    expect(resolveConvergenceLockTtlMs({})).toBe(
      DEFAULT_CONVERGENCE_LOCK_TTL_MS
    );
    expect(
      resolveConvergenceLockTtlMs({
        SYMPHONY_CONVERGENCE_LOCK_TTL_MS: "60000",
      })
    ).toBe(60_000);
  });
});

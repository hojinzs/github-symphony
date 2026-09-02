import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERGENCE_LOCK_TTL_MS,
  explainIssueDispatch,
  getConvergenceLockStatus,
  hasConvergenceLockedRunForIssue,
  resolveConvergenceLockTtlMs,
} from "./explain.js";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type OrchestratorRunRecord,
  type TrackedIssue,
} from "@gh-symphony/core";

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

describe("convergence lock policy", () => {
  it("releases an expired lock and reports expiry", () => {
    const run = convergenceRun("2026-08-05T00:00:00.000Z");
    const status = getConvergenceLockStatus(
      [run],
      "issue-1",
      "Todo",
      "2026-08-05T00:00:00.000Z",
      { now: new Date("2026-08-06T00:00:00.000Z"), ttlMs: 60_000 }
    );

    expect(status).toEqual({ run, expired: true });
    expect(
      hasConvergenceLockedRunForIssue(
        [run],
        "issue-1",
        "Todo",
        "2026-08-05T00:00:00.000Z",
        { now: new Date("2026-08-06T00:00:00.000Z"), ttlMs: 60_000 }
      )
    ).toBeNull();
  });

  it("fails loudly when a lock timestamp cannot be parsed", () => {
    const run = convergenceRun("not-a-timestamp");

    expect(() =>
      hasConvergenceLockedRunForIssue(
        [run],
        "issue-1",
        "Todo",
        "2026-08-05T00:00:00.000Z"
      )
    ).toThrow(/timestamp is invalid/);
  });

  it("keeps the lock when the tracker timestamp is absent", () => {
    const run = convergenceRun("2026-08-05T00:00:00.000Z");

    expect(
      hasConvergenceLockedRunForIssue([run], "issue-1", "Todo", null, {
        now: new Date("2026-08-05T00:01:00.000Z"),
        ttlMs: 60 * 60 * 1000,
      })
    ).toBe(run);
  });

  it("uses a bounded default TTL and accepts a positive override", () => {
    expect(resolveConvergenceLockTtlMs({})).toBe(
      DEFAULT_CONVERGENCE_LOCK_TTL_MS
    );
    expect(
      resolveConvergenceLockTtlMs({ SYMPHONY_CONVERGENCE_LOCK_TTL_MS: "60000" })
    ).toBe(60_000);
  });
});

describe("dispatch limit explanation", () => {
  it("blocks a mixed-case state when its normalized per-state limit is full", () => {
    const issue: TrackedIssue = {
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
    };
    const report = explainIssueDispatch({
      identifier: issue.identifier,
      issue,
      projectRepository: { owner: "acme", name: "platform" },
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      issueRecords: [],
      runs: [
        {
          ...convergenceRun("2026-08-05T00:00:00.000Z"),
          runId: "run-todo",
          issueId: "issue-2",
          issueSubjectId: "issue-2",
          issueIdentifier: "acme/platform#2",
          issueState: " TODO ",
          status: "running",
        },
      ],
      activeRunCount: 1,
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: { todo: 1 },
    });

    expect(report.dispatchable).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "dispatch_limits",
        status: "block",
        details: expect.objectContaining({ activeInState: 1, stateLimit: 1 }),
      })
    );
  });

  it("blocks a failure-suppressed issue after a same-state tracker update", () => {
    const issue: TrackedIssue = {
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
      updatedAt: "2026-08-05T00:02:00.000Z",
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
    };
    const report = explainIssueDispatch({
      identifier: issue.identifier,
      issue,
      projectRepository: { owner: "acme", name: "platform" },
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      issueRecords: [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          workspaceKey: "acme_platform_1",
          completedOnce: false,
          failureRetryCount: 3,
          failureRetrySuppressedState: "Todo",
          state: "released",
          currentRunId: null,
          retryEntry: null,
          updatedAt: "2026-08-05T00:01:00.000Z",
        },
      ],
      runs: [
        {
          ...convergenceRun("2026-08-05T00:01:00.000Z"),
          status: "suppressed",
          lastError:
            "Run suppressed: max_failure_retries_exceeded. failureRetryCount=3.",
        },
      ],
      activeRunCount: 0,
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {},
      maxFailureRetries: 3,
    });

    expect(report.dispatchable).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "runtime_ownership",
        status: "block",
        hint: expect.stringContaining("change the tracker state"),
      })
    );
  });

  it("does not block a sub-cap failure count carrying stale suppression state", () => {
    const issue: TrackedIssue = {
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
      updatedAt: "2026-08-05T00:02:00.000Z",
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
    };
    const report = explainIssueDispatch({
      identifier: issue.identifier,
      issue,
      projectRepository: { owner: "acme", name: "platform" },
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      issueRecords: [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          workspaceKey: "acme_platform_1",
          completedOnce: false,
          failureRetryCount: 1,
          failureRetrySuppressedState: "Todo",
          state: "released",
          currentRunId: null,
          retryEntry: null,
          updatedAt: "2026-08-05T00:01:00.000Z",
        },
      ],
      runs: [],
      activeRunCount: 0,
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {},
      maxFailureRetries: 3,
    });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({
        id: "runtime_ownership",
        message:
          "Failure retry limit has suppressed redispatch for the current tracker state.",
      })
    );
  });
});

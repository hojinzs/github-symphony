import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERGENCE_LOCK_TTL_MS,
  getConvergenceLockStatus,
  hasConvergenceLockedRunForIssue,
  resolveConvergenceLockTtlMs,
} from "./explain.js";
import type { OrchestratorRunRecord } from "@gh-symphony/core";

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

  it("uses a bounded default TTL and accepts a positive override", () => {
    expect(resolveConvergenceLockTtlMs({})).toBe(
      DEFAULT_CONVERGENCE_LOCK_TTL_MS
    );
    expect(
      resolveConvergenceLockTtlMs({ SYMPHONY_CONVERGENCE_LOCK_TTL_MS: "60000" })
    ).toBe(60_000);
  });
});

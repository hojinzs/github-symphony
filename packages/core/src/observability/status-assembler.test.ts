import { describe, expect, it } from "vitest";
import {
  isMatchingIssueRun,
  mapIssueOrchestrationStateToStatus,
} from "./status-assembler.js";
import type { OrchestratorRunRecord } from "../contracts/status-surface.js";

function createRun(
  overrides: Partial<OrchestratorRunRecord> = {}
): OrchestratorRunRecord {
  return {
    runId: "run-1",
    projectId: "project-1",
    projectSlug: "tenant-1",
    issueId: "issue-1",
    issueSubjectId: "subject-1",
    issueIdentifier: "acme/repo#1",
    issueState: "Todo",
    repository: {
      owner: "acme",
      name: "repo",
      cloneUrl: "https://github.com/acme/repo.git",
    },
    status: "running",
    attempt: 1,
    processId: null,
    port: null,
    workingDirectory: "/tmp/workdir",
    issueWorkspaceKey: "workspace-1",
    workspaceRuntimeDir: "/tmp/runtime",
    workflowPath: "WORKFLOW.md",
    retryKind: null,
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    lastError: null,
    nextRetryAt: null,
    ...overrides,
  };
}

describe("status-assembler", () => {
  it("matches runs by project and either issue id or identifier", () => {
    const run = createRun();

    expect(
      isMatchingIssueRun(run, "project-1", "issue-1", "other/repo#2")
    ).toBe(true);
    expect(
      isMatchingIssueRun(run, "project-1", "other-issue", "acme/repo#1")
    ).toBe(true);
    expect(
      isMatchingIssueRun(run, "project-2", "issue-1", "acme/repo#1")
    ).toBe(false);
    expect(
      isMatchingIssueRun(null, "project-1", "issue-1", "acme/repo#1")
    ).toBe(false);
  });

  it("maps orchestration states to status surface values", () => {
    expect(mapIssueOrchestrationStateToStatus("claimed")).toBe("starting");
    expect(mapIssueOrchestrationStateToStatus("running")).toBe("running");
    expect(mapIssueOrchestrationStateToStatus("retry_queued")).toBe(
      "retrying"
    );
    expect(mapIssueOrchestrationStateToStatus("released")).toBe("released");
    expect(mapIssueOrchestrationStateToStatus("unclaimed")).toBe("pending");
  });
});

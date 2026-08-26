import { OrchestratorFsStore } from "/app/packages/orchestrator/dist/fs-store.js";

const now = new Date().toISOString();
const runtimeRoot = "/e2e/work/test-repo/.runtime/orchestrator";
const projectId = "repository";
const issueId = "retry-issue";
const identifier = "test-owner/test-repo#20";
const runId = "restart-failure-run";
const repository = {
  owner: "test-owner",
  name: "test-repo",
  cloneUrl: "/e2e/repos/does-not-exist",
};
const store = new OrchestratorFsStore(runtimeRoot);

await store.saveProjectIssueOrchestrations(projectId, [
  {
    issueId,
    identifier,
    workspaceKey: "test_owner_test_repo_20",
    completedOnce: false,
    failureRetryCount: 1,
    state: "running",
    currentRunId: runId,
    retryEntry: {
      attempt: 2,
      dueAt: now,
      error: "Worker process exited unexpectedly.",
    },
    updatedAt: now,
  },
]);
await store.saveRun({
  runId,
  projectId,
  projectSlug: projectId,
  issueId,
  issueSubjectId: issueId,
  issueIdentifier: identifier,
  issueState: "Ready",
  repository,
  status: "retrying",
  attempt: 2,
  processId: null,
  port: 4601,
  workingDirectory: "/e2e/work/retry-workspace",
  issueWorkspaceKey: "test_owner_test_repo_20",
  workspaceRuntimeDir: "/e2e/work/retry-workspace/.runtime",
  workflowPath: null,
  retryKind: "failure",
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: null,
  lastError: "Worker process exited unexpectedly.",
  nextRetryAt: now,
});

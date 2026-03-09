import type { RepositoryRef } from "../domain/workspace.js";
import type { WorkflowDefinition } from "../workflow/config.js";
import type { WorkflowLifecycleConfig } from "../workflow/lifecycle.js";
import type { TrackedIssue, TrackerAdapterKind } from "./tracker-adapter.js";

export type OrchestratorTrackerConfig = {
  adapter: TrackerAdapterKind;
  bindingId: string;
  apiUrl?: string;
  settings?: Record<string, string>;
};

export type OrchestratorWorkspaceConfig = {
  workspaceId: string;
  slug: string;
  promptGuidelines: string;
  repositories: RepositoryRef[];
  tracker: OrchestratorTrackerConfig;
  runtime: {
    driver: "local";
    workspaceRuntimeDir: string;
    projectRoot: string;
    workerCommand?: string;
  };
};

export type RetryKind = "continuation" | "failure" | "recovery";

export type OrchestratorRunStatus =
  | "pending"
  | "starting"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "suppressed";

export type OrchestratorRunRecord = {
  runId: string;
  workspaceId: string;
  workspaceSlug: string;
  issueId: string;
  issueIdentifier: string;
  phase: TrackedIssue["phase"];
  repository: RepositoryRef;
  status: OrchestratorRunStatus;
  attempt: number;
  processId: number | null;
  port: number | null;
  workingDirectory: string;
  workspaceRuntimeDir: string;
  workflowPath: string | null;
  retryKind: RetryKind | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
};

export type WorkspaceLeaseRecord = {
  leaseKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  phase: TrackedIssue["phase"];
  status: "active" | "released";
  updatedAt: string;
};

export type WorkspaceStatusSnapshot = {
  workspaceId: string;
  slug: string;
  tracker: {
    adapter: TrackerAdapterKind;
    bindingId: string;
  };
  lastTickAt: string;
  health: "idle" | "running" | "degraded";
  summary: {
    dispatched: number;
    suppressed: number;
    recovered: number;
    activeRuns: number;
  };
  activeRuns: Array<{
    runId: string;
    issueIdentifier: string;
    phase: TrackedIssue["phase"];
    status: OrchestratorRunStatus;
    retryKind: RetryKind | null;
    port: number | null;
  }>;
  retryQueue: Array<{
    runId: string;
    issueIdentifier: string;
    retryKind: RetryKind;
    nextRetryAt: string | null;
  }>;
  lastError: string | null;
};

export type WorkflowResolution = {
  workflowPath: string | null;
  workflow: WorkflowDefinition;
  lifecycle: WorkflowLifecycleConfig;
  promptGuidelines: string;
  promptTemplate: string;
  agentCommand: string;
  hookPath: string;
  usedLastKnownGood: boolean;
  validationError: string | null;
};

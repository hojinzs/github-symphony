import type { RepositoryRef } from "../domain/workspace.js";
import type { WorkflowDefinition } from "../workflow/config.js";
import type { WorkflowLifecycleConfig } from "../workflow/lifecycle.js";
import type { TrackerAdapterKind } from "./tracker-adapter.js";

export type OrchestratorTrackerConfig = {
  adapter: TrackerAdapterKind;
  bindingId: string;
  apiUrl?: string;
  settings?: Record<string, string | boolean>;
};

export type OrchestratorTenantConfig = {
  tenantId: string;
  slug: string;
  workspaceDir: string;
  repositories: RepositoryRef[];
  tracker: OrchestratorTrackerConfig;
};

/** @deprecated Use OrchestratorTenantConfig */
export type OrchestratorWorkspaceConfig = OrchestratorTenantConfig;
/** @deprecated Use TenantLeaseRecord */
export type WorkspaceLeaseRecord = TenantLeaseRecord;
/** @deprecated Use TenantStatusSnapshot */
export type WorkspaceStatusSnapshot = TenantStatusSnapshot;

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
  tenantId: string;
  tenantSlug: string;
  issueId: string;
  issueSubjectId: string;
  issueIdentifier: string;
  issueState: string;
  repository: RepositoryRef;
  status: OrchestratorRunStatus;
  attempt: number;
  processId: number | null;
  port: number | null;
  workingDirectory: string;
  issueWorkspaceKey: string | null;
  workspaceRuntimeDir: string;
  workflowPath: string | null;
  retryKind: RetryKind | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  runtimeSession?: RuntimeSessionRow | null;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Turn count from live worker polling (Symphony spec 4.1.6) */
  turnCount?: number;
  /** Worker start time for AGE calculation (milliseconds since epoch) */
  startedAtMs?: number;
  /** Last event description from worker */
  lastEvent?: string | null;
  /** Last event timestamp */
  lastEventAt?: string | null;
};

export type TenantLeaseRecord = {
  leaseKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  status: "active" | "released";
  updatedAt: string;
};

export type RuntimeSessionRow = {
  sessionId: string | null;
  threadId: string | null;
  status: "active" | "completed" | "failed" | null;
  startedAt: string | null;
  updatedAt: string | null;
  exitClassification: string | null;
};

export type LiveWorkerState = {
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  sessionId: string | null;
  turnCount: number;
  lastError: string | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  status: "idle" | "starting" | "running" | "failed" | "completed";
};

export type TenantStatusSnapshot = {
  tenantId: string;
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
    issueState: string;
    status: OrchestratorRunStatus;
    retryKind: RetryKind | null;
    port: number | null;
    processId?: number | null;
    turnCount?: number;
    startedAt?: string | null;
    lastEvent?: string | null;
    lastEventAt?: string | null;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  }>;
  runtimeSession?: RuntimeSessionRow | null;
  retryQueue: Array<{
    runId: string;
    issueIdentifier: string;
    retryKind: RetryKind;
    nextRetryAt: string | null;
  }>;
  codexTotals?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    secondsRunning: number;
  };
  rateLimits?: Record<string, unknown> | null;
  lastError: string | null;
};

export type WorkflowResolution = {
  workflowPath: string | null;
  workflow: WorkflowDefinition;
  lifecycle: WorkflowLifecycleConfig;
  promptTemplate: string;
  agentCommand: string;
  hookPath: string;
  isValid: boolean;
  usedLastKnownGood: boolean;
  validationError: string | null;
};

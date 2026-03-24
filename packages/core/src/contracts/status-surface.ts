import type { RepositoryRef } from "../domain/workspace.js";
import type { WorkflowDefinition } from "../workflow/config.js";
import type { WorkflowLifecycleConfig } from "../workflow/lifecycle.js";
import type { TrackerAdapterKind } from "./tracker-adapter.js";
import type { RunAttemptPhase } from "./run-attempt-phase.js";
import type { OrchestratorEvent } from "../observability/structured-events.js";

export type OrchestratorTrackerConfig = {
  adapter: TrackerAdapterKind;
  bindingId: string;
  apiUrl?: string;
  settings?: Record<string, string | number | boolean>;
};

export type OrchestratorProjectConfig = {
  projectId: string;
  slug: string;
  workspaceDir: string;
  repositories: RepositoryRef[];
  tracker: OrchestratorTrackerConfig;
};

export type RetryKind = "continuation" | "failure" | "recovery";

export const WORKFLOW_EXECUTION_PHASES = [
  "planning",
  "human-review",
  "implementation",
  "awaiting-merge",
  "completed",
] as const;

export type WorkflowExecutionPhase =
  (typeof WORKFLOW_EXECUTION_PHASES)[number];

export function isWorkflowExecutionPhase(
  value: unknown
): value is WorkflowExecutionPhase {
  return (
    typeof value === "string" &&
    WORKFLOW_EXECUTION_PHASES.includes(value as WorkflowExecutionPhase)
  );
}

export type OrchestratorRunStatus =
  | "pending"
  | "starting"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "suppressed";

export const SESSION_EXIT_CLASSIFICATIONS = [
  "completed",
  "budget-exceeded",
  "convergence-detected",
  "max-turns-reached",
  "user-input-required",
  "timeout",
  "error",
] as const;

export type SessionExitClassification =
  (typeof SESSION_EXIT_CLASSIFICATIONS)[number];

export function isSessionExitClassification(
  value: unknown
): value is SessionExitClassification {
  return (
    typeof value === "string" &&
    SESSION_EXIT_CLASSIFICATIONS.includes(value as SessionExitClassification)
  );
}

export type OrchestratorRunRecord = {
  runId: string;
  projectId: string;
  projectSlug: string;
  issueId: string;
  issueSubjectId: string;
  issueIdentifier: string;
  issueTitle?: string;
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
  /** Persisted thread state shared across worker sessions. */
  threadId?: string | null;
  /** Total turns accumulated across worker sessions for the run. */
  cumulativeTurnCount?: number;
  /** Brief summary of the most recent completed/terminal turn. */
  lastTurnSummary?: string | null;
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
  /** Source used to derive `lastEventAt` for stall detection compatibility */
  lastEventAtSource?: "event-channel" | "worker-api" | null;
  /** Current workflow execution phase reported by the worker */
  executionPhase?: WorkflowExecutionPhase | null;
  /** Technical run attempt phase aligned with Symphony spec 7.2 */
  runPhase?: RunAttemptPhase | null;
  /** Latest rate-limit payload observed from the worker runtime */
  rateLimits?: Record<string, unknown> | null;
};

export type RuntimeSessionRow = {
  sessionId: string | null;
  threadId: string | null;
  status: "active" | "completed" | "failed" | null;
  startedAt: string | null;
  updatedAt: string | null;
  exitClassification: SessionExitClassification | null;
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
  executionPhase: WorkflowExecutionPhase | null;
  runPhase: RunAttemptPhase | null;
  status: "idle" | "starting" | "running" | "failed" | "completed";
  rateLimits: Record<string, unknown> | null;
};

export type ProjectStatusSnapshot = {
  projectId: string;
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
    executionPhase?: WorkflowExecutionPhase | null;
    runPhase?: RunAttemptPhase | null;
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

export type IssueStatusEvent = {
  at: string;
  event: OrchestratorEvent["event"];
  message: string | null;
};

export type IssueStatusSnapshot = {
  issue_identifier: string;
  issue_id: string;
  status: string;
  workspace: {
    path: string | null;
  };
  attempts: {
    restart_count: number;
    current_retry_attempt: number;
  };
  running: {
    session_id: string | null;
    turn_count: number | null;
    state: string | null;
    started_at: string | null;
    last_event: string | null;
    last_message: string | null;
    last_event_at: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    } | null;
  } | null;
  retry: {
    due_at: string;
    kind: RetryKind | null;
    error: string | null;
  } | null;
  logs: {
    codex_session_logs: Array<{
      label: string;
      path: string;
      url: string | null;
    }>;
  };
  recent_events: IssueStatusEvent[];
  last_error: string | null;
  tracked: Record<string, unknown>;
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

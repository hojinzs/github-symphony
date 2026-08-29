import { isAbsolute, relative, resolve } from "node:path";
import type { RepositoryRef } from "../domain/workspace.js";
import type {
  WorkflowDefinition,
  WorkflowPriorityConfig,
} from "../workflow/config.js";
import type { WorkflowLifecycleConfig } from "../workflow/lifecycle.js";
import type { TrackerAdapterKind } from "./tracker-adapter.js";
import type { RunAttemptPhase } from "./run-attempt-phase.js";
import type { OrchestratorEvent } from "../observability/structured-events.js";

export type OrchestratorTrackerSettingValue =
  | string
  | number
  | boolean
  | null
  | OrchestratorTrackerSettingValue[]
  | { [key: string]: OrchestratorTrackerSettingValue };

export type OrchestratorTrackerConfig = {
  adapter: TrackerAdapterKind;
  bindingId: string;
  apiUrl?: string;
  priority?: WorkflowPriorityConfig | null;
  settings?: Record<string, OrchestratorTrackerSettingValue>;
};

export type WorkflowSource =
  | { type: "repo"; path?: string }
  | { type: "external"; path: string };

export type PopulateStrategy = "clone" | "worktree-cache";

export type OrchestratorProjectConfig = {
  projectId: string;
  slug: string;
  /** Root directory containing persistent per-issue workspaces. */
  workspaceDir: string;
  /** Repository checkout used as the daemon cwd for repo-embedded projects. */
  repositoryDir?: string;
  repository: RepositoryRef;
  tracker: OrchestratorTrackerConfig;
  /** Defaults to the repository-local workflow for legacy project configs. */
  workflowSource?: WorkflowSource;
  /** Defaults to cloning for legacy project configs. */
  populateStrategy?: PopulateStrategy;
  /** Standalone project directory, when configuration is managed externally. */
  projectDir?: string;
};

/**
 * Materializes standalone-project defaults and rejects malformed persisted
 * configuration before it reaches an orchestrator service.
 */
export function normalizeOrchestratorProjectConfig(
  config: OrchestratorProjectConfig
): OrchestratorProjectConfig {
  assertAbsoluteProjectDir(config);
  const workflowSource = normalizeWorkflowSource(config);
  const populateStrategy = normalizePopulateStrategy(config);
  if (workflowSource.type === "repo" && config.repositoryDir) {
    const workspaceRoot = resolve(config.workspaceDir);
    const repositoryDir = resolve(config.repositoryDir);
    const repositoryRelativeToRoot = relative(workspaceRoot, repositoryDir);
    if (
      repositoryRelativeToRoot === "" ||
      (!repositoryRelativeToRoot.startsWith("..") &&
        !isAbsolute(repositoryRelativeToRoot))
    ) {
      throw new Error(
        `Project ${JSON.stringify(config.projectId)} workspace.root ${JSON.stringify(workspaceRoot)} must not equal or contain the repository checkout ${JSON.stringify(repositoryDir)}.`
      );
    }
  }

  return {
    ...config,
    workflowSource,
    populateStrategy,
  };
}

/** Rejects legacy repo metadata on daemon startup without blocking CLI migration commands. */
export function assertDispatchableOrchestratorProjectConfig(
  config: OrchestratorProjectConfig
): void {
  const workflowSource = normalizeWorkflowSource(config);
  const repositoryPath = config.repository?.path;
  if (
    workflowSource.type === "repo" &&
    !config.repositoryDir &&
    repositoryPath &&
    resolve(config.workspaceDir) === resolve(repositoryPath)
  ) {
    throw new Error(
      `Project ${JSON.stringify(config.projectId)} uses legacy repo-embedded path metadata. Stop the daemon and run 'gh-symphony repo init' again before starting it.`
    );
  }
}

function assertAbsoluteProjectDir(config: OrchestratorProjectConfig): void {
  if (config.projectDir === undefined) {
    return;
  }
  if (typeof config.projectDir !== "string" || !isAbsolute(config.projectDir)) {
    throw new Error(
      `Project ${JSON.stringify(config.projectId)} project directory ${JSON.stringify(config.projectDir)} must be absolute.`
    );
  }
}

function normalizeWorkflowSource(
  config: OrchestratorProjectConfig
): WorkflowSource {
  const workflowSource = config.workflowSource as unknown;
  if (workflowSource === undefined) {
    return { type: "repo" };
  }
  if (!isRecord(workflowSource)) {
    throw new Error(
      `Project ${JSON.stringify(config.projectId)} has unsupported workflow source ${JSON.stringify(workflowSource)}.`
    );
  }
  if (workflowSource.type === "repo") {
    if (workflowSource.path === undefined) {
      return { type: "repo" };
    }
    if (typeof workflowSource.path !== "string" || !workflowSource.path) {
      throw new Error(
        `Project ${JSON.stringify(config.projectId)} repository workflow source path must be a non-empty absolute path.`
      );
    }
    if (!isAbsolute(workflowSource.path)) {
      throw new Error(
        `Project ${JSON.stringify(config.projectId)} repository workflow source path ${JSON.stringify(workflowSource.path)} must be absolute.`
      );
    }
    return { type: "repo", path: workflowSource.path };
  }
  if (workflowSource.type !== "external") {
    throw new Error(
      `Project ${JSON.stringify(config.projectId)} has unsupported workflow source type ${JSON.stringify(workflowSource.type)}.`
    );
  }
  if (typeof workflowSource.path !== "string" || !workflowSource.path) {
    throw new Error(
      `Project ${JSON.stringify(config.projectId)} external workflow source requires a path.`
    );
  }
  if (!isAbsolute(workflowSource.path)) {
    throw new Error(
      `Project ${JSON.stringify(config.projectId)} external workflow source path ${JSON.stringify(workflowSource.path)} must be absolute.`
    );
  }

  return { type: "external", path: workflowSource.path };
}

function normalizePopulateStrategy(
  config: OrchestratorProjectConfig
): PopulateStrategy {
  const populateStrategy = config.populateStrategy;
  if (populateStrategy === undefined) {
    return "clone";
  }
  if (populateStrategy === "clone" || populateStrategy === "worktree-cache") {
    return populateStrategy;
  }
  throw new Error(
    `Project ${JSON.stringify(config.projectId)} has unsupported populate strategy ${JSON.stringify(populateStrategy)}.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type RetryKind = "continuation" | "failure" | "recovery";

export const WORKFLOW_EXECUTION_PHASES = [
  "planning",
  "human-review",
  "implementation",
  "awaiting-merge",
  "completed",
] as const;

export type WorkflowExecutionPhase = (typeof WORKFLOW_EXECUTION_PHASES)[number];

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
  "canceled_by_reconciliation",
  "error",
  "incomplete-turn-dirty-workspace",
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
  /** Canonical tracker placement used for issue-scoped tracker mutations. */
  trackerItemId?: string;
  issueIdentifier: string;
  issueTitle?: string;
  /** Tracker-native URL captured when the run was created. */
  issueUrl?: string | null;
  issueState: string;
  repository: RepositoryRef;
  status: OrchestratorRunStatus;
  attempt: number;
  processId: number | null;
  /** Exit code recorded when the worker process closes. Zero is a clean exit. */
  workerExitCode?: number | null;
  /** Signal recorded when the worker process is terminated by the host. */
  workerExitSignal?: string | null;
  /** Stable process start-time identity used to reject PID reuse. */
  processIdentity?: string | null;
  /** Project-lock owner identity of the orchestrator instance that spawned this run. */
  ownerInstanceId?: string | null;
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
  /** Runtime from completed worker sessions in the current run lifecycle. */
  cumulativeRuntimeMs?: number;
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
    cumulativeInputTokens?: number;
    cumulativeOutputTokens?: number;
    cumulativeTotalTokens?: number;
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
  /** Latest orchestrator-owned transition comment publication outcome. */
  transitionComment?: {
    status: "created" | "unchanged" | "failed";
    updatedAt: string;
    error: string | null;
  } | null;
  /** Confirmed API lifecycle progress awaiting the worker's clean exit. */
  trackerProgressConfirmedAt?: string | null;
  /** Consecutive unknown canonical reads while finalizing a successful run. */
  finalizationDeferralCount?: number;
  /** Recoverable dirty workspace left by an incomplete runtime session. */
  recovery?: IncompleteTurnRecoveryInfo | null;
};

export type IncompleteTurnRecoveryInfo = {
  kind: "incomplete-turn-dirty-workspace";
  runId: string;
  issueId: string;
  issueIdentifier: string;
  workspacePath: string;
  dirtyFiles: string[];
  lastEvent: string | null;
  lastEventAt: string | null;
  sessionId: string | null;
  threadId: string | null;
  suggestedCommand: string;
  detectedAt: string;
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
  repository: RepositoryRef;
  tracker: {
    adapter: TrackerAdapterKind;
    bindingId: string;
    /** Public, non-secret tracker identifiers safe to expose on status APIs. */
    settings?: Record<string, OrchestratorTrackerSettingValue>;
  };
  lastTickAt: string;
  /** Workflow revision applied during the most recent reconciliation tick. */
  workflow?: {
    /** Short SHA-256-derived identifier; never includes workflow contents or environment values. */
    revision: string | null;
    loadedAt: string | null;
    isValid: boolean;
    usedLastKnownGood: boolean;
  };
  /** Non-fatal configuration conditions that operators should review. */
  warnings?: string[];
  health: "idle" | "running" | "degraded";
  summary: {
    dispatched: number;
    suppressed: number;
    recovered: number;
    skipped?: number;
    activeRuns: number;
  };
  activeRuns: Array<{
    runId: string;
    issueIdentifier: string;
    issueUrl?: string | null;
    issueWorkspaceKey: string | null;
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
      cumulativeInputTokens?: number;
      cumulativeOutputTokens?: number;
      cumulativeTotalTokens?: number;
    };
  }>;
  issueWorkspaces?: Array<{
    issueIdentifier: string;
    workspaceKey: string;
    status: "active" | "cleanup_pending" | "removed";
  }>;
  runtimeSession?: RuntimeSessionRow | null;
  recovery?: IncompleteTurnRecoveryInfo | null;
  retryQueue: Array<{
    runId: string;
    issueId: string;
    issueIdentifier: string;
    issueUrl?: string | null;
    attempt: number;
    error: string | null;
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
  /** Effective tracker reconciliation interval used for the next daemon tick. */
  effectivePollIntervalMs?: number;
  dispatchSuppressedUntil?: string | null;
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
      cumulative_input_tokens?: number;
      cumulative_output_tokens?: number;
      cumulative_total_tokens?: number;
    } | null;
  } | null;
  retry: {
    due_at: string;
    kind: RetryKind | null;
    error: string | null;
  } | null;
  recovery: IncompleteTurnRecoveryInfo | null;
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
  /** Short SHA-256-derived identifier for the effective workflow contents. */
  revision: string | null;
  loadedAt: string | null;
  isValid: boolean;
  usedLastKnownGood: boolean;
  validationError: string | null;
};

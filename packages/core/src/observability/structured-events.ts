/**
 * Structured orchestration events emitted during project reconciliation.
 *
 * Each event includes a UTC timestamp (`at`), a discriminated `event` field,
 * and payload fields specific to that event kind. Events are appended to the
 * per-run NDJSON log via the state store and are designed to be machine-readable
 * without coupling consumers to internal implementation details.
 */

export type RunDispatchedEvent = {
  at: string;
  event: "run-dispatched";
  projectId: string;
  issueIdentifier: string;
  issueState?: string;
  issueId?: string;
  sessionId?: string;
};

export type RunRecoveredEvent = {
  at: string;
  event: "run-recovered";
  projectId?: string;
  issueIdentifier: string;
  sessionId?: string;
  issueId?: string;
};

export type RunRetriedEvent = {
  at: string;
  event: "run-retried";
  projectId?: string;
  issueIdentifier: string;
  sessionId?: string;
  issueId?: string;
  attempt: number;
  retryKind: string;
  nextRetryAt: string;
};

export type RunFailedEvent = {
  at: string;
  event: "run-failed";
  projectId?: string;
  issueIdentifier: string;
  sessionId?: string;
  issueId?: string;
  attempt: number;
  lastError: string;
};

export type RunSuppressedEvent = {
  at: string;
  event: "run-suppressed";
  projectId?: string;
  issueIdentifier: string;
  issueId?: string;
  reason: string;
};

export type HookExecutedEvent = {
  at: string;
  event: "hook-executed";
  projectId?: string;
  hook: string;
  outcome: string;
  durationMs?: number;
  error?: string | null;
};

export type HookFailedEvent = {
  at: string;
  event: "hook-failed";
  projectId?: string;
  hook: string;
  error: string | null;
};

export type WorkspaceCleanupEvent = {
  at: string;
  event: "workspace-cleanup";
  projectId?: string;
  workspaceKey: string;
  issueIdentifier: string;
  issueId?: string;
  outcome: "removed" | "cleanup_blocked" | "skipped";
  error?: string | null;
};

export type WorkerErrorEvent = {
  at: string;
  event: "worker-error";
  projectId?: string;
  runId: string;
  issueIdentifier: string;
  error: string;
  attempt: number;
};

/**
 * Union of all structured orchestration events. Discriminated on `event`.
 */
export type OrchestratorEvent =
  | RunDispatchedEvent
  | RunRecoveredEvent
  | RunRetriedEvent
  | RunFailedEvent
  | RunSuppressedEvent
  | HookExecutedEvent
  | HookFailedEvent
  | WorkspaceCleanupEvent
  | WorkerErrorEvent;

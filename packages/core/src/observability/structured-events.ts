/**
 * Structured orchestration events emitted during workspace reconciliation.
 *
 * Each event includes a UTC timestamp (`at`), a discriminated `event` field,
 * and payload fields specific to that event kind. Events are appended to the
 * per-run NDJSON log via the state store and are designed to be machine-readable
 * without coupling consumers to internal implementation details.
 */

export type RunDispatchedEvent = {
  at: string;
  event: "run-dispatched";
  workspaceId: string;
  issueIdentifier: string;
  phase: string;
};

export type RunRecoveredEvent = {
  at: string;
  event: "run-recovered";
  issueIdentifier: string;
};

export type RunRetriedEvent = {
  at: string;
  event: "run-retried";
  issueIdentifier: string;
  attempt: number;
  retryKind: string;
  nextRetryAt: string;
};

export type RunFailedEvent = {
  at: string;
  event: "run-failed";
  issueIdentifier: string;
  attempt: number;
  lastError: string;
};

export type RunSuppressedEvent = {
  at: string;
  event: "run-suppressed";
  issueIdentifier: string;
  reason: string;
};

export type HookExecutedEvent = {
  at: string;
  event: "hook-executed";
  hook: string;
  outcome: string;
  durationMs?: number;
  error?: string | null;
};

export type HookFailedEvent = {
  at: string;
  event: "hook-failed";
  hook: string;
  error: string | null;
};

export type WorkspaceCleanupEvent = {
  at: string;
  event: "workspace-cleanup";
  workspaceKey: string;
  issueIdentifier: string;
  outcome: "removed" | "cleanup_blocked" | "skipped";
  error?: string | null;
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
  | WorkspaceCleanupEvent;

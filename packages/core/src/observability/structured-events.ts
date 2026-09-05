/**
 * Structured orchestration events emitted during project reconciliation.
 *
 * Each event includes a UTC timestamp (`at`), a discriminated `event` field,
 * and payload fields specific to that event kind. Events are appended to the
 * per-run NDJSON log via the state store and are designed to be machine-readable
 * without coupling consumers to internal implementation details.
 */

export type TrackerEventMetadata = {
  adapter: string;
  projectSlug?: string;
};

export type IssueEventMetadata = {
  identifier: string;
  id: string;
};

export type TrackerListEvent = {
  at: string;
  event: "tracker.list";
  projectId: string;
  tracker: TrackerEventMetadata;
  issue: IssueEventMetadata;
  rateLimits?: Record<string, unknown> | null;
};

export type TrackerFetchByIdsEvent = {
  at: string;
  event: "tracker.fetchByIds";
  projectId: string;
  tracker: TrackerEventMetadata;
  issue: IssueEventMetadata;
  rateLimits?: Record<string, unknown> | null;
};

export type TrackerStateRequestEvent = {
  at: string;
  event: "tracker.state";
  projectId: string;
  runId: string;
  tracker: TrackerEventMetadata;
  issue: IssueEventMetadata;
  requestType: "state-read" | "transition-request";
  expectedState: string | null;
  targetState: string | null;
  confirmedState: string | null;
  outcome: "confirmed" | "expected_state_mismatch" | "rejected" | "failed";
  reason: string | null;
  error: string | null;
  /** State-read routability decision from the refreshed tracker snapshot. */
  routable?: boolean | null;
  /** Concrete reason when a refreshed state-read is not routable. */
  routableReason?: string | null;
  rateLimits?: Record<string, unknown> | null;
};

export type TrackerTransitionCommentEvent = {
  at: string;
  event: "tracker.transition-comment";
  projectId: string;
  runId: string;
  tracker: TrackerEventMetadata;
  issue: IssueEventMetadata;
  expectedState: string;
  targetState: string;
  outcome: "created" | "unchanged" | "failed";
  error: string | null;
  rateLimits?: Record<string, unknown> | null;
};

export type RunDispatchedEvent = {
  at: string;
  event: "run-dispatched";
  projectId: string;
  issueIdentifier: string;
  issueState?: string;
  issueId?: string;
  /** Workflow revision applied when this run was dispatched. */
  workflowRevision?: string | null;
  sessionId?: string;
  tracker?: TrackerEventMetadata;
  issue?: IssueEventMetadata;
};

export type WorkerCredentialMissingEvent = {
  at: string;
  event: "worker-credential-missing";
  projectId: string;
  runId: string;
  issueIdentifier: string;
  issueId: string;
  tracker: TrackerEventMetadata;
};

export type RunRecoveredEvent = {
  at: string;
  event: "run-recovered";
  projectId?: string;
  issueIdentifier: string;
  sessionId?: string;
  issueId?: string;
};

export type RunRestartFailedEvent = {
  at: string;
  event: "run-restart-failed";
  projectId?: string;
  runId: string;
  issueIdentifier: string;
  issueId?: string;
  attempt: number;
  error: string;
  retrySuppressed: boolean;
  nextRetryAt?: string;
};

export type RunRetriedEvent = {
  at: string;
  event: "run-retried";
  projectId?: string;
  runId: string;
  issueIdentifier: string;
  sessionId?: string;
  issueId?: string;
  attempt: number;
  retryKind: string;
  dueAt: string;
  error: string | null;
};

export type RetryPostponedEvent = {
  at: string;
  event: "retry-postponed";
  projectId?: string;
  runId: string;
  issueIdentifier: string;
  issueId?: string;
  attempt: number;
  dueAt: string;
  reason: string;
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

export type RunOwnershipSkippedEvent = {
  at: string;
  event: "run-ownership-skipped";
  projectId: string;
  runId: string;
  issueIdentifier: string;
  issueId: string;
  operation: "signal" | "claim-release" | "workspace-cleanup";
  reason: "owner-alive";
};

export type RunFinalizationDeferredEvent = {
  at: string;
  event: "run-finalization-deferred";
  projectId: string;
  runId: string;
  issueIdentifier: string;
  issueId: string;
  reason:
    | "workflow-unavailable"
    | "tracker-item-missing"
    | "tracker-read-failed";
  error: string;
  consecutiveDeferrals: number;
  maxDeferrals: number;
  exhausted: boolean;
};

export type ConvergenceLockExpiredEvent = {
  at: string;
  event: "convergence-lock-expired";
  projectId?: string;
  issueIdentifier: string;
  issueId?: string;
  runId: string;
  ttlMs: number;
  reason: "ttl_expired";
};

export type RecoveryDirtyWorkspaceEvent = {
  at: string;
  event: "recovery-dirty-workspace";
  projectId?: string;
  issueIdentifier: string;
  issueId?: string;
  workspaceKey: string;
  dirtyFiles: string[];
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
  outcome: "removed" | "skipped";
  error?: string | null;
};

export type WorkspaceRootRelocatedEvent = {
  at: string;
  event: "workspace-root-relocated";
  projectId?: string;
  workspaceKey: string;
  issueIdentifier: string;
  issueId?: string;
  previousWorkspacePath: string;
  configuredWorkspacePath: string;
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

export type TurnStartedEvent = {
  at: string;
  event: "turn_started";
  projectId?: string;
  issueIdentifier: string;
  issueId?: string;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  turnCount: number;
};

export type TurnCompletedEvent = {
  at: string;
  event: "turn_completed";
  projectId?: string;
  issueIdentifier: string;
  issueId?: string;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  turnCount: number;
  startedAt: string;
  durationMs: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export type TurnFailedEvent = {
  at: string;
  event: "turn_failed";
  projectId?: string;
  issueIdentifier: string;
  issueId?: string;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  turnCount: number;
  startedAt: string;
  durationMs: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  error: string | null;
};

export type SessionInvalidatedEvent = {
  at: string;
  event: "session_invalidated";
  projectId?: string;
  runId: string;
  issueIdentifier?: string;
  issueId?: string;
  sessionId: string;
  replacementSessionId: string;
  reason: string;
};

export type PriorityLabelConflictResolvedEvent = {
  at: string;
  event: "priority.label_conflict_resolved";
  issue: IssueEventMetadata;
  matched: Array<{
    label: string;
    value: number;
  }>;
  chosenValue: number;
  chosenLabels: string[];
};

export type PriorityUnmappedEvent = {
  at: string;
  event: "priority.unmapped";
  issue: IssueEventMetadata;
  source: "project-field" | "labels";
  rawValues: string[];
};

/**
 * Union of all structured orchestration events. Discriminated on `event`.
 */
export type OrchestratorEvent =
  | TrackerListEvent
  | TrackerFetchByIdsEvent
  | TrackerStateRequestEvent
  | TrackerTransitionCommentEvent
  | RunDispatchedEvent
  | WorkerCredentialMissingEvent
  | RunRecoveredEvent
  | RunRestartFailedEvent
  | RunRetriedEvent
  | RetryPostponedEvent
  | RunFailedEvent
  | RunSuppressedEvent
  | RunOwnershipSkippedEvent
  | RunFinalizationDeferredEvent
  | ConvergenceLockExpiredEvent
  | RecoveryDirtyWorkspaceEvent
  | HookExecutedEvent
  | HookFailedEvent
  | WorkspaceCleanupEvent
  | WorkspaceRootRelocatedEvent
  | WorkerErrorEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | SessionInvalidatedEvent
  | PriorityLabelConflictResolvedEvent
  | PriorityUnmappedEvent;

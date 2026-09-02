export const ISSUE_ORCHESTRATION_STATES = [
  "unclaimed",
  "claimed",
  "running",
  "retry_queued",
  "released",
] as const;

export type IssueOrchestrationState =
  (typeof ISSUE_ORCHESTRATION_STATES)[number];

/** States that may establish a newly persisted coordination record. */
export const ISSUE_ORCHESTRATION_INITIAL_STATES: readonly IssueOrchestrationState[] =
  ["claimed", "running", "retry_queued"];

/**
 * Legal lifecycle changes for an orchestrator's per-issue coordination record.
 *
 * Self-transitions are deliberate: reconciliation may refresh a record's
 * metadata while retaining its lifecycle state.
 */
export const ISSUE_ORCHESTRATION_TRANSITIONS: Record<
  IssueOrchestrationState,
  readonly IssueOrchestrationState[]
> = {
  // No orchestrator code writes this; it can appear in legacy or externally
  // authored records and is retained for Record completeness and display-only use.
  unclaimed: ["unclaimed", "claimed"],
  claimed: ["claimed", "running", "retry_queued", "released"],
  running: ["running", "retry_queued", "released"],
  retry_queued: ["retry_queued", "running", "released"],
  released: ["released", "claimed"],
};

/** Throws when a coordination record attempts an invalid lifecycle change. */
export function assertIssueOrchestrationTransition(
  from: IssueOrchestrationState | null,
  to: IssueOrchestrationState
): void {
  if (from === null) {
    if (!ISSUE_ORCHESTRATION_INITIAL_STATES.includes(to)) {
      throw new Error(`Invalid initial issue orchestration state: ${to}`);
    }
    return;
  }

  const allowed = ISSUE_ORCHESTRATION_TRANSITIONS[from];
  if (!allowed) {
    throw new Error(`Unknown issue orchestration state: ${from}`);
  }
  if (!allowed.includes(to)) {
    throw new Error(`Invalid issue orchestration transition: ${from} -> ${to}`);
  }
}
export type IssueRetryEntry = {
  attempt: number;
  dueAt: string;
  error: string | null;
};

export type IssueOrchestrationRecord = {
  issueId: string;
  identifier: string;
  workspaceKey: string;
  completedOnce: boolean;
  failureRetryCount: number;
  /** Tracker state at which the failure retry budget was exhausted. */
  failureRetrySuppressedState?: string | null;
  state: IssueOrchestrationState;
  currentRunId: string | null;
  retryEntry: IssueRetryEntry | null;
  updatedAt: string;
};

/** Machine-readable failure reason retained in run diagnostics. */
export const MAX_FAILURE_RETRIES_EXCEEDED_REASON =
  "max_failure_retries_exceeded";

/** Operator guidance shared by retry suppression and dispatch diagnostics. */
export const FAILURE_RETRY_REARM_HINT =
  "Manual intervention required: change the tracker state to re-arm retries.";

/**
 * Returns whether a persisted failure budget suppresses the supplied tracker
 * state. An absent field uses the legacy run fallback; explicit null records a
 * successful or state-change clear and must remain re-armable.
 */
export function isFailureRetrySuppressedForState(
  record: IssueOrchestrationRecord,
  state: string,
  legacySuppressedState: string | null = null
): boolean {
  return (
    resolveFailureRetrySuppressedState(record, legacySuppressedState) === state
  );
}

/** Returns whether the failure budget is no longer suppressed for this state. */
export function isFailureRetryRearmedForState(
  record: IssueOrchestrationRecord,
  state: string,
  legacySuppressedState: string | null = null
): boolean {
  return !isFailureRetrySuppressedForState(
    record,
    state,
    legacySuppressedState
  );
}

function resolveFailureRetrySuppressedState(
  record: IssueOrchestrationRecord,
  legacySuppressedState: string | null
): string | null {
  // Missing is a pre-field persisted record. Null is an explicit clear, so it
  // must not revive a stale state from a legacy suppressed run.
  return record.failureRetrySuppressedState === undefined
    ? legacySuppressedState
    : record.failureRetrySuppressedState;
}

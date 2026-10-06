/** Wire version, independent of CLI/package release versions. */
export const PROTOCOL_VERSION = 1 as const;
export const OPERATOR_ACTOR = "local-owner" as const;

/** Durations are milliseconds; byte limits refer to UTF-8 encoded wire data. */
export const LIMITS = Object.freeze({
  enrollmentTokenLifetimeMs: 10 * 60_000,
  pollTimeoutMs: 25_000,
  commandClaimLifetimeMs: 30_000,
  executionObservationTimeoutMs: 60_000,
  managedProjectsPerAgent: 100,
  observationBodyBytes: 4 * 1024 * 1024,
  activeCommandsPerProject: 1,
  activeCommandsPerAgent: 4,
  pendingReadsPerAgent: 4,
  pendingReadsPerProject: 1,
  readLifetimeMs: 30_000,
  completedReadRetentionMs: 60_000,
  runSummariesPerProject: 100,
  logChunkBytes: 256 * 1024,
  defaultPageSize: 25,
  maximumPageSize: 100,
  journalRetentionAfterAcknowledgmentMs: 30 * 24 * 60 * 60_000,
  terminalCommandRetentionMs: 90 * 24 * 60 * 60_000,
});

export const ERROR_CODES = [
  "agent_offline",
  "project_unmanaged",
  "project_invalid",
  "unsupported_protocol",
  "command_conflict",
  "idempotency_conflict",
  "command_expired",
  "unresolved_command",
  "process_unverified",
  "log_unavailable",
  "cursor_reset",
  "superseded_target",
  "claim_owner_conflict",
  "agent_busy",
  "read_busy",
  "invalid_input",
  "unauthenticated",
  "access_revoked",
  "not_found",
  "session_conflict",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS = Object.freeze({
  agent_offline: 409,
  project_unmanaged: 403,
  project_invalid: 409,
  unsupported_protocol: 400,
  command_conflict: 409,
  idempotency_conflict: 409,
  command_expired: 409,
  unresolved_command: 409,
  process_unverified: 409,
  log_unavailable: 404,
  cursor_reset: 409,
  superseded_target: 409,
  claim_owner_conflict: 409,
  agent_busy: 409,
  read_busy: 409,
  invalid_input: 400,
  unauthenticated: 401,
  access_revoked: 403,
  not_found: 404,
  session_conflict: 409,
} satisfies Record<ErrorCode, number>);

export const COMMAND_STATES = [
  "accepted",
  "executing",
  "succeeded",
  "failed",
  "expired",
  "unknown",
] as const;
export const READ_STATES = [
  "pending",
  "completed",
  "expired",
  "unavailable",
] as const;
export const LOG_STREAMS = ["orchestrator", "worker", "events"] as const;

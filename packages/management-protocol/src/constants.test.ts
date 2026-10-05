import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  LIMITS,
  PROTOCOL_VERSION,
} from "./index.js";

describe("approved v1 contract", () => {
  it("pins version and capacity to the approved design", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(LIMITS).toEqual({
      enrollmentTokenLifetimeMs: 600000,
      pollTimeoutMs: 25000,
      commandClaimLifetimeMs: 30000,
      executionObservationTimeoutMs: 60000,
      managedProjectsPerAgent: 100,
      observationBodyBytes: 4194304,
      activeCommandsPerProject: 1,
      activeCommandsPerAgent: 4,
      pendingReadsPerAgent: 4,
      pendingReadsPerProject: 1,
      readLifetimeMs: 30000,
      completedReadRetentionMs: 60000,
      runSummariesPerProject: 100,
      logChunkBytes: 262144,
      defaultPageSize: 25,
      maximumPageSize: 100,
      journalRetentionAfterAcknowledgmentMs: 2592000000,
      terminalCommandRetentionMs: 7776000000,
    });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
  it("assigns every stable diagnostic its HTTP category", () => {
    expect(ERROR_HTTP_STATUS).toEqual({
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
    });
    expect([...ERROR_CODES].sort()).toEqual(
      Object.keys(ERROR_HTTP_STATUS).sort()
    );
  });
});

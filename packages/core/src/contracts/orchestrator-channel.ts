import {
  isWorkflowExecutionPhase,
  isSessionExitClassification,
  type SessionExitClassification,
  type WorkflowExecutionPhase,
} from "./status-surface.js";
import {
  isRunAttemptPhase,
  type RunAttemptPhase,
} from "./run-attempt-phase.js";

export type OrchestratorChannelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type OrchestratorChannelSessionInfo = {
  threadId: string | null;
  turnId: string | null;
  turnCount: number;
  sessionId: string | null;
  exitClassification?: SessionExitClassification | null;
};

export type OrchestratorChannelCodexUpdateEvent = {
  type: "codex_update";
  issueId: string;
  lastEventAt: string;
  tokenUsage?: OrchestratorChannelTokenUsage;
  rateLimits?: Record<string, unknown>;
  sessionInfo?: OrchestratorChannelSessionInfo;
  executionPhase?: WorkflowExecutionPhase | null;
  runPhase?: RunAttemptPhase | null;
  lastError?: string | null;
  event?: string;
};

export type OrchestratorChannelHeartbeatEvent = {
  type: "heartbeat";
  issueId: string;
  lastEventAt: string | null;
  tokenUsage: OrchestratorChannelTokenUsage;
  rateLimits: Record<string, unknown> | null;
  sessionInfo: OrchestratorChannelSessionInfo | null;
  executionPhase: WorkflowExecutionPhase | null;
  runPhase: RunAttemptPhase | null;
  lastError: string | null;
};

export type OrchestratorChannelEvent =
  | OrchestratorChannelCodexUpdateEvent
  | OrchestratorChannelHeartbeatEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTokenUsage(
  value: unknown
): value is OrchestratorChannelTokenUsage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    typeof value.totalTokens === "number"
  );
}

function isSessionInfo(
  value: unknown
): value is OrchestratorChannelSessionInfo {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (typeof value.threadId === "string" || value.threadId === null) &&
    (typeof value.turnId === "string" || value.turnId === null) &&
    typeof value.turnCount === "number" &&
    (typeof value.sessionId === "string" || value.sessionId === null) &&
    (!("exitClassification" in value) ||
      value.exitClassification === undefined ||
      value.exitClassification === null ||
      isSessionExitClassification(value.exitClassification))
  );
}

export function isOrchestratorChannelEvent(
  value: unknown
): value is OrchestratorChannelEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.issueId !== "string") {
    return false;
  }

  if (value.type === "codex_update") {
    if (typeof value.lastEventAt !== "string") {
      return false;
    }

    if (
      "event" in value &&
      value.event !== undefined &&
      typeof value.event !== "string"
    ) {
      return false;
    }

    if (
      "tokenUsage" in value &&
      value.tokenUsage !== undefined &&
      !isTokenUsage(value.tokenUsage)
    ) {
      return false;
    }

    if (
      "rateLimits" in value &&
      value.rateLimits !== undefined &&
      !isRecord(value.rateLimits)
    ) {
      return false;
    }

    if (
      "sessionInfo" in value &&
      value.sessionInfo !== undefined &&
      !isSessionInfo(value.sessionInfo)
    ) {
      return false;
    }

    if (
      "executionPhase" in value &&
      value.executionPhase !== undefined &&
      value.executionPhase !== null &&
      !isWorkflowExecutionPhase(value.executionPhase)
    ) {
      return false;
    }

    if (
      "runPhase" in value &&
      value.runPhase !== undefined &&
      value.runPhase !== null &&
      !isRunAttemptPhase(value.runPhase)
    ) {
      return false;
    }

    if (
      "lastError" in value &&
      value.lastError !== undefined &&
      value.lastError !== null &&
      typeof value.lastError !== "string"
    ) {
      return false;
    }

    return true;
  }

  if (value.type === "heartbeat") {
    if (value.lastEventAt !== null && typeof value.lastEventAt !== "string") {
      return false;
    }

    if (!isTokenUsage(value.tokenUsage)) {
      return false;
    }

    if (value.rateLimits !== null && !isRecord(value.rateLimits)) {
      return false;
    }

    if (value.sessionInfo !== null && !isSessionInfo(value.sessionInfo)) {
      return false;
    }

    if (
      value.executionPhase !== null &&
      !isWorkflowExecutionPhase(value.executionPhase)
    ) {
      return false;
    }

    if (value.runPhase !== null && !isRunAttemptPhase(value.runPhase)) {
      return false;
    }

    if (value.lastError !== null && typeof value.lastError !== "string") {
      return false;
    }

    return true;
  }

  return false;
}

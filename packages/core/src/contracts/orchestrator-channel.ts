export type OrchestratorChannelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type OrchestratorChannelEvent = {
  type: "codex_update";
  issueId: string;
  lastEventAt: string;
  tokenUsage?: OrchestratorChannelTokenUsage;
  rateLimits?: Record<string, unknown>;
  event?: string;
};

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

export function isOrchestratorChannelEvent(
  value: unknown
): value is OrchestratorChannelEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.type !== "codex_update" ||
    typeof value.issueId !== "string" ||
    typeof value.lastEventAt !== "string"
  ) {
    return false;
  }

  if ("event" in value && value.event !== undefined && typeof value.event !== "string") {
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

  return true;
}

export type TokenUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type SessionBudgetState = {
  cumulativeTurnCount: number;
  tokenUsageBaseline: TokenUsageSnapshot;
  sessionStartedAt: string | null;
  globalMaxTurns: number | null;
  maxTokens: number | null;
  sessionTimeoutMs: number | null;
};

export type BudgetExceededReason =
  | "global-turns"
  | "tokens"
  | "session-timeout";

export function resolveSessionBudgetState(
  env: NodeJS.ProcessEnv
): SessionBudgetState {
  return {
    cumulativeTurnCount: parseNonNegativeInteger(
      env.SYMPHONY_CUMULATIVE_TURN_COUNT
    ),
    tokenUsageBaseline: {
      inputTokens: parseNonNegativeInteger(
        env.SYMPHONY_CUMULATIVE_INPUT_TOKENS
      ),
      outputTokens: parseNonNegativeInteger(
        env.SYMPHONY_CUMULATIVE_OUTPUT_TOKENS
      ),
      totalTokens: parseNonNegativeInteger(env.SYMPHONY_CUMULATIVE_TOTAL_TOKENS),
    },
    sessionStartedAt: normalizeTimestamp(env.SYMPHONY_SESSION_STARTED_AT),
    globalMaxTurns: parsePositiveInteger(env.SYMPHONY_GLOBAL_MAX_TURNS),
    maxTokens: parsePositiveInteger(env.SYMPHONY_MAX_TOKENS),
    sessionTimeoutMs: parsePositiveInteger(env.SYMPHONY_SESSION_TIMEOUT_MS),
  };
}

export function resolveBudgetExceededReason(
  budget: SessionBudgetState,
  currentSessionTurnCount: number,
  currentTokenUsage: TokenUsageSnapshot,
  now: Date
): BudgetExceededReason | null {
  const totalTurns = budget.cumulativeTurnCount + currentSessionTurnCount;
  if (
    budget.globalMaxTurns !== null &&
    totalTurns >= budget.globalMaxTurns
  ) {
    return "global-turns";
  }

  const totalTokens =
    budget.tokenUsageBaseline.totalTokens + currentTokenUsage.totalTokens;
  if (budget.maxTokens !== null && totalTokens >= budget.maxTokens) {
    return "tokens";
  }

  if (
    budget.sessionTimeoutMs !== null &&
    budget.sessionStartedAt !== null &&
    now.getTime() - new Date(budget.sessionStartedAt).getTime() >=
      budget.sessionTimeoutMs
  ) {
    return "session-timeout";
  }

  return null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

function parseNonNegativeInteger(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function normalizeTimestamp(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

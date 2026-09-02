import { matchesWorkflowState } from "@gh-symphony/core";

export const DEFAULT_REFRESH_FAILURE_THRESHOLD = 3;
const ORCHESTRATOR_REQUEST_TIMEOUT_MS = 5_000;

export type TrackerRefreshState =
  | "active"
  | "non-actionable"
  | "unsupported"
  | "unknown";

export type TrackerRefreshDiagnostic = {
  message: string;
  httpStatus?: number;
  providerError?: string;
  exceptionMessage?: string;
};

export type TrackerRefreshResult = {
  state: TrackerRefreshState;
  diagnostic: TrackerRefreshDiagnostic | null;
};

export type TurnLeaseResult =
  | { status: "acquired"; expiresAt: string }
  | { status: "denied"; reason: string }
  | { status: "unavailable"; reason: string };

export function resolveRefreshFailureThreshold(
  value: string | undefined
): number {
  if (!value?.trim()) {
    return DEFAULT_REFRESH_FAILURE_THRESHOLD;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REFRESH_FAILURE_THRESHOLD;
}

export function updateRefreshFailureCount(
  state: TrackerRefreshState,
  currentCount: number,
  threshold: number
): { count: number; failClosed: boolean } {
  const count =
    state === "unsupported"
      ? currentCount
      : state === "unknown"
        ? currentCount + 1
        : 0;
  return { count, failClosed: count >= threshold };
}

export type TrackerRefreshGateAction =
  | "continue"
  | "defer"
  | "converge"
  | "complete"
  | "fail-closed"
  | "skip";

export type TrackerRefreshGateContext = "between-turn" | "convergence";

export function resolveTrackerRefreshGate(
  state: TrackerRefreshState,
  currentCount: number,
  threshold: number,
  context: TrackerRefreshGateContext = "between-turn"
): { action: TrackerRefreshGateAction; count: number } {
  const refreshFailures = updateRefreshFailureCount(
    state,
    currentCount,
    threshold
  );
  if (state === "non-actionable") {
    return { action: "complete", count: refreshFailures.count };
  }
  if (state === "unsupported") {
    return {
      action: context === "convergence" ? "converge" : "skip",
      count: refreshFailures.count,
    };
  }
  if (state === "active" && context === "convergence") {
    return { action: "converge", count: refreshFailures.count };
  }
  if (
    state === "unknown" &&
    context === "convergence" &&
    !refreshFailures.failClosed
  ) {
    return { action: "defer", count: refreshFailures.count };
  }
  return {
    action: refreshFailures.failClosed ? "fail-closed" : "continue",
    count: refreshFailures.count,
  };
}

export async function refreshTrackerState(
  env: NodeJS.ProcessEnv,
  activeStates: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<TrackerRefreshResult> {
  const orchestratorUrl = env.SYMPHONY_ORCHESTRATOR_URL;
  const runId = env.SYMPHONY_RUN_ID;
  const apiToken = env.SYMPHONY_ORCHESTRATOR_TOKEN;

  if (!orchestratorUrl) {
    return {
      state: "unknown",
      diagnostic: { message: "orchestrator endpoint not configured" },
    };
  }
  if (!runId) {
    return {
      state: "unknown",
      diagnostic: { message: "worker run identity not configured" },
    };
  }
  if (!apiToken) {
    return {
      state: "unknown",
      diagnostic: { message: "orchestrator token not configured" },
    };
  }

  try {
    const response = await fetchImpl(
      `${orchestratorUrl}/api/v1/tracker-state`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-symphony-run-id": runId,
          "x-symphony-orchestrator-token": apiToken,
        },
        body: JSON.stringify({ type: "state-read" }),
        signal: AbortSignal.timeout(ORCHESTRATOR_REQUEST_TIMEOUT_MS),
      }
    );
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      outcome?: string;
      state?: string | null;
      routable?: boolean | null;
      routableReason?: string | null;
      error?: string | null;
    } | null;
    const providerError =
      typeof result?.error === "string" ? result.error : undefined;
    if (!response.ok) {
      if (
        response.status === 403 &&
        providerError === "tracker_state_requests_unsupported"
      ) {
        return {
          state: "unsupported",
          diagnostic: {
            message: "tracker state requests unsupported",
            httpStatus: response.status,
            providerError,
          },
        };
      }
      return {
        state: "unknown",
        diagnostic: {
          message: "tracker state request failed",
          httpStatus: response.status,
          ...(providerError ? { providerError } : {}),
        },
      };
    }

    if (
      result?.ok !== true ||
      result.outcome !== "confirmed" ||
      typeof result.state !== "string" ||
      typeof result.routable !== "boolean"
    ) {
      return {
        state: "unknown",
        diagnostic: {
          message: "invalid tracker state response",
          httpStatus: response.status,
          ...(providerError ? { providerError } : {}),
        },
      };
    }

    const active = matchesWorkflowState(result.state, activeStates);
    if (active && !result.routable) {
      console.error(
        `[worker] issue no longer routable: ${result.routableReason ?? "no reason provided"}`
      );
    }
    return {
      state: active && result.routable ? "active" : "non-actionable",
      diagnostic: null,
    };
  } catch (error) {
    return {
      state: "unknown",
      diagnostic: {
        message: "tracker state request failed",
        exceptionMessage:
          error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function formatTrackerRefreshResult(
  result: TrackerRefreshResult
): string {
  if (!result.diagnostic) return result.state;

  const details = [
    result.diagnostic.message,
    result.diagnostic.httpStatus === undefined
      ? null
      : `HTTP ${result.diagnostic.httpStatus}`,
    result.diagnostic.providerError
      ? `error=${result.diagnostic.providerError}`
      : null,
    result.diagnostic.exceptionMessage
      ? `exception=${result.diagnostic.exceptionMessage}`
      : null,
  ].filter((value): value is string => value !== null);
  return `${result.state} (${details.join(", ")})`;
}

export function reportTrackerRefresh(
  result: TrackerRefreshResult,
  label: string,
  unsupportedWarningLogged: boolean,
  write: (message: string) => void = (message) => process.stderr.write(message)
): boolean {
  write(`[worker] ${label}: ${formatTrackerRefreshResult(result)}\n`);
  if (result.state !== "unsupported" || unsupportedWarningLogged) {
    return unsupportedWarningLogged;
  }

  write(
    "[worker] warning: tracker state refresh capability unavailable; skipping tracker gates and using local convergence signals\n"
  );
  return true;
}

export async function acquireTurnLease(
  env: NodeJS.ProcessEnv,
  turn: number,
  fetchImpl: typeof fetch = fetch
): Promise<TurnLeaseResult> {
  const orchestratorUrl = env.SYMPHONY_ORCHESTRATOR_URL;
  const issueId = env.SYMPHONY_ISSUE_ID;
  const runId = env.SYMPHONY_RUN_ID;
  const apiToken = env.SYMPHONY_ORCHESTRATOR_TOKEN;

  if (!orchestratorUrl || !issueId || !runId || !apiToken) {
    return {
      status: "unavailable",
      reason: "missing orchestrator URL, token, or worker run identity",
    };
  }

  try {
    const response = await fetchImpl(
      `${orchestratorUrl}/api/v1/worker-turn-lease`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ issueId, runId, turn }),
        signal: AbortSignal.timeout(ORCHESTRATOR_REQUEST_TIMEOUT_MS),
      }
    );
    const payload = (await response.json().catch(() => null)) as {
      acquired?: boolean;
      expiresAt?: string;
      reason?: string;
    } | null;

    if (!response.ok) {
      if (response.status === 409 || response.status === 403) {
        return {
          status: "denied",
          reason:
            payload?.reason ?? `lease request rejected (${response.status})`,
        };
      }
      return {
        status: "unavailable",
        reason: payload?.reason ?? `lease endpoint returned ${response.status}`,
      };
    }

    if (payload?.acquired !== true || !payload.expiresAt) {
      return { status: "unavailable", reason: "invalid lease response" };
    }

    return { status: "acquired", expiresAt: payload.expiresAt };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

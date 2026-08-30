import { matchesWorkflowState } from "@gh-symphony/core";

export const DEFAULT_REFRESH_FAILURE_THRESHOLD = 3;
const ORCHESTRATOR_REQUEST_TIMEOUT_MS = 5_000;

export type TrackerRefreshState = "active" | "non-actionable" | "unknown";

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
  const count = state === "unknown" ? currentCount + 1 : 0;
  return { count, failClosed: count >= threshold };
}

export async function refreshTrackerState(
  env: NodeJS.ProcessEnv,
  activeStates: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<TrackerRefreshState> {
  const orchestratorUrl = env.SYMPHONY_ORCHESTRATOR_URL;
  const runId = env.SYMPHONY_RUN_ID;
  const apiToken = env.SYMPHONY_ORCHESTRATOR_TOKEN;

  if (!orchestratorUrl || !runId || !apiToken) {
    return "unknown";
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
    if (!response.ok) return "unknown";

    const result = (await response.json()) as {
      ok?: boolean;
      outcome?: string;
      state?: string | null;
      routable?: boolean | null;
    };
    if (
      result.ok !== true ||
      result.outcome !== "confirmed" ||
      typeof result.state !== "string" ||
      typeof result.routable !== "boolean"
    ) {
      return "unknown";
    }

    const active = matchesWorkflowState(result.state, activeStates);
    return active && result.routable ? "active" : "non-actionable";
  } catch {
    return "unknown";
  }
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

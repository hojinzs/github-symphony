/**
 * Builds a machine-readable `WorkspaceStatusSnapshot` from orchestration state.
 *
 * This centralizes snapshot construction so the orchestrator service and any
 * future status surface consumers use consistent logic for deriving health,
 * active runs, retry queue, and aggregate summary fields.
 */

import type {
  OrchestratorRunRecord,
  OrchestratorWorkspaceConfig,
  WorkspaceStatusSnapshot,
} from "../contracts/status-surface.js";

export type SnapshotInput = {
  workspace: OrchestratorWorkspaceConfig;
  activeRuns: OrchestratorRunRecord[];
  allRuns?: OrchestratorRunRecord[];
  summary: {
    dispatched: number;
    suppressed: number;
    recovered: number;
  };
  lastTickAt: string;
  lastError: string | null;
  rateLimits?: Record<string, unknown> | null;
};

/**
 * Construct a `WorkspaceStatusSnapshot` from reconciliation state.
 *
 * Active runs are partitioned into active execution rows and retry queue rows.
 * Health is derived from the presence of errors and active runs.
 */
export function buildWorkspaceSnapshot(
  input: SnapshotInput
): WorkspaceStatusSnapshot {
  const { workspace, activeRuns, allRuns, summary, lastTickAt, lastError, rateLimits } = input;

  return {
    workspaceId: workspace.workspaceId,
    slug: workspace.slug,
    tracker: {
      adapter: workspace.tracker.adapter,
      bindingId: workspace.tracker.bindingId,
    },
    lastTickAt,
    health: lastError ? "degraded" : activeRuns.length > 0 ? "running" : "idle",
    summary: {
      dispatched: summary.dispatched,
      suppressed: summary.suppressed,
      recovered: summary.recovered,
      activeRuns: activeRuns.length,
    },
    activeRuns: activeRuns.map((run) => ({
      runId: run.runId,
      issueIdentifier: run.issueIdentifier,
      phase: run.phase,
      status: run.status,
      retryKind: run.retryKind,
      port: run.port,
      runtimeSession: run.runtimeSession ?? null,
    })),
    retryQueue: activeRuns
      .filter((run) => run.status === "retrying" && run.retryKind)
      .map((run) => ({
        runId: run.runId,
        issueIdentifier: run.issueIdentifier,
        retryKind: run.retryKind ?? "failure",
        nextRetryAt: run.nextRetryAt,
      })),
    lastError,
    codexTotals: aggregateTokenUsage(allRuns ?? activeRuns, lastTickAt),
    rateLimits: rateLimits ?? null,
  };
}


/**
 * Aggregate token usage across all run records that have token data.
 * Returns cumulative totals and an estimate of total running time.
 */
function aggregateTokenUsage(
  runs: OrchestratorRunRecord[],
  lastTickAt: string
): WorkspaceStatusSnapshot["codexTotals"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let earliestStart: number | null = null;
  let latestEnd: number | null = null;

  for (const run of runs) {
    if (run.tokenUsage) {
      inputTokens += run.tokenUsage.inputTokens;
      outputTokens += run.tokenUsage.outputTokens;
      totalTokens += run.tokenUsage.totalTokens;
    }
    if (run.startedAt) {
      const start = new Date(run.startedAt).getTime();
      if (earliestStart === null || start < earliestStart) {
        earliestStart = start;
      }
    }
    const end = run.completedAt
      ? new Date(run.completedAt).getTime()
      : new Date(lastTickAt).getTime();
    if (latestEnd === null || end > latestEnd) {
      latestEnd = end;
    }
  }

  const secondsRunning =
    earliestStart !== null && latestEnd !== null
      ? Math.max(0, Math.round((latestEnd - earliestStart) / 1000))
      : 0;

  return { inputTokens, outputTokens, totalTokens, secondsRunning };
}
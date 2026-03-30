/**
 * Builds a machine-readable `ProjectStatusSnapshot` from orchestration state.
 *
 * This centralizes snapshot construction so the orchestrator service and any
 * future status surface consumers use consistent logic for deriving health,
 * active runs, retry queue, and aggregate summary fields.
 */

import type {
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
  ProjectStatusSnapshot,
} from "../contracts/status-surface.js";

export type SnapshotInput = {
  project: OrchestratorProjectConfig;
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
 * Construct a `ProjectStatusSnapshot` from reconciliation state.
 *
 * Active runs are partitioned into active execution rows and retry queue rows.
 * Health is derived from the presence of errors and active runs.
 */
export function buildProjectSnapshot(
  input: SnapshotInput
): ProjectStatusSnapshot {
  const {
    project,
    activeRuns,
    allRuns,
    summary,
    lastTickAt,
    lastError,
    rateLimits,
  } = input;
  const cumulativeTokenUsageByIssue = aggregateTokenUsageByIssue(
    allRuns ?? activeRuns
  );

  return {
    projectId: project.projectId,
    slug: project.slug,
    tracker: {
      adapter: project.tracker.adapter,
      bindingId: project.tracker.bindingId,
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
      issueState: run.issueState,
      status: run.status,
      retryKind: run.retryKind,
      port: run.port,
      runtimeSession: run.runtimeSession ?? null,
      // New fields from live worker data
      processId: run.processId ?? null,
      turnCount: run.turnCount,
      startedAt: run.startedAt ?? null,
      lastEvent: run.lastEvent ?? null,
      lastEventAt: run.lastEventAt ?? null,
      executionPhase: run.executionPhase ?? null,
      runPhase: run.runPhase ?? null,
      tokenUsage: attachCumulativeTokenUsage(
        run.tokenUsage,
        cumulativeTokenUsageByIssue.get(run.issueId)
      ),
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

function aggregateTokenUsageByIssue(
  runs: OrchestratorRunRecord[]
): Map<string, NonNullable<OrchestratorRunRecord["tokenUsage"]>> {
  const totals = new Map<string, NonNullable<OrchestratorRunRecord["tokenUsage"]>>();

  for (const run of runs) {
    if (!run.tokenUsage) {
      continue;
    }

    const current = totals.get(run.issueId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    current.inputTokens += run.tokenUsage.inputTokens;
    current.outputTokens += run.tokenUsage.outputTokens;
    current.totalTokens += run.tokenUsage.totalTokens;
    totals.set(run.issueId, current);
  }

  return totals;
}

function attachCumulativeTokenUsage(
  tokenUsage: OrchestratorRunRecord["tokenUsage"] | undefined,
  cumulative: OrchestratorRunRecord["tokenUsage"] | undefined
): OrchestratorRunRecord["tokenUsage"] | undefined {
  if (!tokenUsage) {
    return undefined;
  }

  return {
    ...tokenUsage,
    cumulativeInputTokens: cumulative?.inputTokens ?? tokenUsage.inputTokens,
    cumulativeOutputTokens:
      cumulative?.outputTokens ?? tokenUsage.outputTokens,
    cumulativeTotalTokens: cumulative?.totalTokens ?? tokenUsage.totalTokens,
  };
}

/**
 * Aggregate token usage across all run records that have token data.
 * Returns cumulative totals and an estimate of total running time.
 */
function aggregateTokenUsage(
  runs: OrchestratorRunRecord[],
  lastTickAt: string
): ProjectStatusSnapshot["codexTotals"] {
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

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
  previousSnapshot?: ProjectStatusSnapshot | null;
  eligibleIssues?: number | null;
  unscheduledEligibleIssues?: number | null;
  trackerCycleSucceeded?: boolean | null;
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
    previousSnapshot,
    eligibleIssues,
    unscheduledEligibleIssues,
    trackerCycleSucceeded,
    rateLimits,
  } = input;
  const retryQueue = activeRuns
    .filter((run) => run.status === "retrying" && run.retryKind)
    .map((run) => ({
      runId: run.runId,
      issueIdentifier: run.issueIdentifier,
      retryKind: run.retryKind ?? "failure",
      nextRetryAt: run.nextRetryAt,
    }));
  const cumulativeTokenUsageByIssue = aggregateTokenUsageByIssue(
    allRuns ?? activeRuns
  );
  const monitoring = buildMonitoringSnapshot({
    activeRuns,
    allRuns: allRuns ?? activeRuns,
    retryQueue,
    lastTickAt,
    summary,
    previousSnapshot,
    eligibleIssues: eligibleIssues ?? null,
    unscheduledEligibleIssues: unscheduledEligibleIssues ?? null,
    trackerCycleSucceeded: trackerCycleSucceeded ?? null,
  });

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
    retryQueue,
    monitoring,
    lastError,
    codexTotals: aggregateTokenUsage(allRuns ?? activeRuns, lastTickAt),
    rateLimits: rateLimits ?? null,
  };
}

const DISPATCH_STARVATION_THRESHOLD_CYCLES = 3;
const TRACKER_DEGRADED_FAILURE_THRESHOLD = 1;
const TRACKER_DOWN_FAILURE_THRESHOLD = 3;

function buildMonitoringSnapshot(input: {
  activeRuns: OrchestratorRunRecord[];
  allRuns: OrchestratorRunRecord[];
  retryQueue: ProjectStatusSnapshot["retryQueue"];
  lastTickAt: string;
  summary: SnapshotInput["summary"];
  previousSnapshot?: ProjectStatusSnapshot | null;
  eligibleIssues: number | null;
  unscheduledEligibleIssues: number | null;
  trackerCycleSucceeded: boolean | null;
}): NonNullable<ProjectStatusSnapshot["monitoring"]> {
  const stalledRuns = input.activeRuns.filter((run) => run.runPhase === "stalled");
  const runningRuns = input.activeRuns.filter(
    (run) => run.status === "running" || run.status === "starting"
  );
  const heartbeatAges = runningRuns
    .map((run) => ({
      ageMs: resolveHeartbeatAgeMs(run, input.lastTickAt),
      lastEventAt: run.lastEventAt ?? run.startedAt ?? null,
    }))
    .filter(
      (
        entry
      ): entry is {
        ageMs: number;
        lastEventAt: string | null;
      } => entry.ageMs !== null
    );
  const nextRetryAt = input.retryQueue
    .map((entry) => entry.nextRetryAt)
    .filter((value): value is string => typeof value === "string")
    .sort()[0] ?? null;
  const retryExhaustedRuns = buildLatestRunByIssue(input.allRuns).filter(
    (run) =>
      run.status === "suppressed" &&
      typeof run.lastError === "string" &&
      run.lastError.includes("max_failure_retries_exceeded")
  );
  const previousMonitoring = input.previousSnapshot?.monitoring;
  const starvationConsecutiveCycles =
    input.eligibleIssues !== null &&
    input.eligibleIssues > 0 &&
    input.summary.dispatched === 0
      ? (previousMonitoring?.dispatch.starvationConsecutiveCycles ?? 0) + 1
      : 0;
  const previousTrackerApi = previousMonitoring?.trackerApi;
  const totalCycles =
    (previousTrackerApi?.totalCycles ?? 0) +
    (input.trackerCycleSucceeded === null ? 0 : 1);
  const failedCycles =
    (previousTrackerApi?.failedCycles ?? 0) +
    (input.trackerCycleSucceeded === false ? 1 : 0);
  const consecutiveFailures =
    input.trackerCycleSucceeded === null
      ? (previousTrackerApi?.consecutiveFailures ?? 0)
      : input.trackerCycleSucceeded
        ? 0
        : (previousTrackerApi?.consecutiveFailures ?? 0) + 1;
  const errorRate = totalCycles > 0 ? failedCycles / totalCycles : 0;
  const availability =
    consecutiveFailures >= TRACKER_DOWN_FAILURE_THRESHOLD
      ? "down"
      : consecutiveFailures >= TRACKER_DEGRADED_FAILURE_THRESHOLD
        ? "degraded"
        : "healthy";

  return {
    stalledRuns: {
      count: stalledRuns.length,
      runIds: stalledRuns.map((run) => run.runId),
      issueIdentifiers: stalledRuns.map((run) => run.issueIdentifier),
    },
    heartbeat: {
      maxAgeMs:
        heartbeatAges.length > 0
          ? Math.max(...heartbeatAges.map((entry) => entry.ageMs))
          : null,
      oldestLastEventAt:
        heartbeatAges.sort((left, right) => right.ageMs - left.ageMs)[0]
          ?.lastEventAt ?? null,
      runningCount: runningRuns.length,
    },
    retryQueue: {
      size: input.retryQueue.length,
      nextRetryAt,
    },
    retryExhaustion: {
      count: retryExhaustedRuns.length,
      issueIdentifiers: retryExhaustedRuns.map((run) => run.issueIdentifier),
    },
    dispatch: {
      eligibleIssues: input.eligibleIssues,
      unscheduledEligibleIssues: input.unscheduledEligibleIssues,
      starvationConsecutiveCycles,
      starvationThresholdCycles: DISPATCH_STARVATION_THRESHOLD_CYCLES,
      starved:
        starvationConsecutiveCycles >= DISPATCH_STARVATION_THRESHOLD_CYCLES,
    },
    trackerApi: {
      availability,
      totalCycles,
      failedCycles,
      consecutiveFailures,
      errorRate,
      lastSuccessAt:
        input.trackerCycleSucceeded === true
          ? input.lastTickAt
          : (previousTrackerApi?.lastSuccessAt ?? null),
      lastFailureAt:
        input.trackerCycleSucceeded === false
          ? input.lastTickAt
          : (previousTrackerApi?.lastFailureAt ?? null),
    },
  };
}

function buildLatestRunByIssue(
  runs: OrchestratorRunRecord[]
): OrchestratorRunRecord[] {
  const byIssue = new Map<string, OrchestratorRunRecord>();
  for (const run of runs) {
    const existing = byIssue.get(run.issueId);
    if (!existing) {
      byIssue.set(run.issueId, run);
      continue;
    }
    if (
      new Date(run.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()
    ) {
      byIssue.set(run.issueId, run);
    }
  }
  return [...byIssue.values()];
}

function resolveHeartbeatAgeMs(
  run: OrchestratorRunRecord,
  lastTickAt: string
): number | null {
  const lastActivityAt = run.lastEventAt ?? run.startedAt;
  if (!lastActivityAt) {
    return null;
  }

  const ageMs = new Date(lastTickAt).getTime() - new Date(lastActivityAt).getTime();
  return Number.isFinite(ageMs) ? Math.max(0, ageMs) : null;
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

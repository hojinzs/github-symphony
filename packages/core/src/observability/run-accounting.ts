import type {
  OrchestratorRunRecord,
  ProjectStatusSnapshot,
} from "../contracts/status-surface.js";

/**
 * Aggregate token usage across all run records that have token data.
 * Returns cumulative totals and an estimate of total running time.
 */
export function aggregateTokenUsage(
  runs: readonly OrchestratorRunRecord[],
  lastTickAt: string
): NonNullable<ProjectStatusSnapshot["codexTotals"]> {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const run of runs) {
    if (run.tokenUsage) {
      inputTokens += run.tokenUsage.inputTokens;
      outputTokens += run.tokenUsage.outputTokens;
      totalTokens += run.tokenUsage.totalTokens;
    }
  }

  const runtimeMs = Array.from(runsByLifecycle(runs).values()).reduce(
    (total, lifecycleRuns) =>
      total + runtimeMsForLifecycle(lifecycleRuns, lastTickAt),
    0
  );
  const secondsRunning = Math.max(0, Math.round(runtimeMs / 1000));

  return { inputTokens, outputTokens, totalTokens, secondsRunning };
}

function runsByLifecycle(
  runs: readonly OrchestratorRunRecord[]
): Map<string, OrchestratorRunRecord[]> {
  const groupedRuns = new Map<string, OrchestratorRunRecord[]>();

  for (const run of runs) {
    const lifecycleId = run.runtimeLifecycleId ?? run.createdAt;
    const key = `${run.projectId}:${run.issueId}:${lifecycleId}`;
    groupedRuns.set(key, [...(groupedRuns.get(key) ?? []), run]);
  }

  return groupedRuns;
}

function runtimeMsForLifecycle(
  runs: readonly OrchestratorRunRecord[],
  lastTickAt: string
): number {
  // Records written before cumulativeRuntimeMs existed share the legacy
  // createdAt lifecycle identity. Sum their individual sessions so upgrading
  // does not discard already-finished runtime.
  if (!runs.some((run) => run.cumulativeRuntimeMs !== undefined)) {
    return runs.reduce(
      (total, run) => total + runtimeMsForSnapshot(run, lastTickAt),
      0
    );
  }

  return runtimeMsForSnapshot(latestSession(runs), lastTickAt);
}

function latestSession(
  runs: readonly OrchestratorRunRecord[]
): OrchestratorRunRecord {
  return runs.reduce((latest, candidate) => {
    const latestUpdatedAt = new Date(latest.updatedAt).getTime();
    const candidateUpdatedAt = new Date(candidate.updatedAt).getTime();
    if (candidateUpdatedAt !== latestUpdatedAt) {
      return candidateUpdatedAt > latestUpdatedAt ? candidate : latest;
    }
    if ((candidate.status === "running") !== (latest.status === "running")) {
      return candidate.status === "running" ? candidate : latest;
    }
    const latestStartedAt = latest.startedAt ?? "";
    const candidateStartedAt = candidate.startedAt ?? "";
    if (candidateStartedAt !== latestStartedAt) {
      return candidateStartedAt > latestStartedAt ? candidate : latest;
    }
    return candidate.runId > latest.runId ? candidate : latest;
  });
}

function runtimeMsForSnapshot(
  run: OrchestratorRunRecord,
  lastTickAt: string
): number {
  const accumulatedRuntimeMs = run.cumulativeRuntimeMs ?? 0;
  if (!run.startedAt) {
    return accumulatedRuntimeMs;
  }

  const startedAtMs = new Date(run.startedAt).getTime();
  const endedAt =
    run.completedAt ??
    (run.runtimeSession?.status !== "active"
      ? run.runtimeSession?.updatedAt
      : null) ??
    (run.status === "running" ? lastTickAt : run.updatedAt);
  const endedAtMs = new Date(endedAt).getTime();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return accumulatedRuntimeMs;
  }

  return accumulatedRuntimeMs + Math.max(0, endedAtMs - startedAtMs);
}

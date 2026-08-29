/**
 * Builds a machine-readable `ProjectStatusSnapshot` from orchestration state.
 *
 * This centralizes snapshot construction so the orchestrator service and any
 * future status surface consumers use consistent logic for deriving health,
 * active runs, retry queue, and aggregate summary fields.
 */

import type {
  IncompleteTurnRecoveryInfo,
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
  ProjectStatusSnapshot,
  WorkflowResolution,
} from "../contracts/status-surface.js";
import type { IssueWorkspaceRecord } from "../domain/issue.js";

export type SnapshotInput = {
  project: OrchestratorProjectConfig;
  activeRuns: OrchestratorRunRecord[];
  allRuns?: OrchestratorRunRecord[];
  summary: {
    dispatched: number;
    suppressed: number;
    recovered: number;
    skipped?: number;
  };
  lastTickAt: string;
  lastError: string | null;
  rateLimits?: Record<string, unknown> | null;
  effectivePollIntervalMs?: number;
  dispatchSuppressedUntil?: string | null;
  issueWorkspaces?: readonly IssueWorkspaceRecord[];
  warnings?: string[];
  workflowResolution?: WorkflowResolution | null;
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
    effectivePollIntervalMs,
    dispatchSuppressedUntil,
    issueWorkspaces,
    warnings,
    workflowResolution,
  } = input;
  const cumulativeTokenUsageByIssue = aggregateTokenUsageByIssue(
    allRuns ?? activeRuns
  );

  return {
    repository: project.repository,
    tracker: {
      adapter: project.tracker.adapter,
      bindingId: project.tracker.bindingId,
      settings: project.tracker.settings,
    },
    lastTickAt,
    ...(workflowResolution
      ? {
          workflow: {
            revision: workflowResolution.revision,
            loadedAt: workflowResolution.loadedAt,
            isValid: workflowResolution.isValid,
            usedLastKnownGood: workflowResolution.usedLastKnownGood,
          },
        }
      : {}),
    warnings: warnings ?? [],
    health: lastError ? "degraded" : activeRuns.length > 0 ? "running" : "idle",
    summary: {
      dispatched: summary.dispatched,
      suppressed: summary.suppressed,
      recovered: summary.recovered,
      skipped: summary.skipped ?? 0,
      activeRuns: activeRuns.length,
    },
    activeRuns: activeRuns.map((run) => ({
      runId: run.runId,
      issueIdentifier: run.issueIdentifier,
      issueUrl: run.issueUrl ?? null,
      issueWorkspaceKey: run.issueWorkspaceKey ?? null,
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
    issueWorkspaces: (issueWorkspaces ?? []).map((workspace) => ({
      issueIdentifier: workspace.issueIdentifier,
      workspaceKey: workspace.workspaceKey,
      status: workspace.status,
    })),
    retryQueue: activeRuns
      .filter((run) => run.status === "retrying" && run.retryKind)
      .map((run) => ({
        runId: run.runId,
        issueId: run.issueId,
        issueIdentifier: run.issueIdentifier,
        issueUrl: run.issueUrl ?? null,
        attempt: run.attempt,
        error: run.lastError,
        retryKind: run.retryKind ?? "failure",
        nextRetryAt: run.nextRetryAt,
      })),
    recovery: findLatestRecovery(
      [...(allRuns ?? []), ...activeRuns],
      issueWorkspaces ?? []
    ),
    lastError,
    codexTotals: aggregateTokenUsage(allRuns ?? activeRuns, lastTickAt),
    rateLimits: rateLimits ?? null,
    ...(effectivePollIntervalMs === undefined
      ? {}
      : { effectivePollIntervalMs }),
    dispatchSuppressedUntil: dispatchSuppressedUntil ?? null,
  };
}

function findLatestRecovery(
  runs: OrchestratorRunRecord[],
  issueWorkspaces: readonly IssueWorkspaceRecord[]
): ProjectStatusSnapshot["recovery"] {
  return (
    [...runs]
      .filter((run) => isUnresolvedRecoveryRun(run, runs, issueWorkspaces))
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt).getTime();
        const rightTime = new Date(right.updatedAt).getTime();
        return rightTime - leftTime;
      })
      .find((run) => run.recovery)?.recovery ?? null
  );
}

function isUnresolvedRecoveryRun(
  run: OrchestratorRunRecord,
  runs: OrchestratorRunRecord[],
  issueWorkspaces: readonly IssueWorkspaceRecord[]
): boolean {
  if (!run.recovery) {
    return false;
  }

  if (!isRecoveryWorkspaceActionable(run, run.recovery, issueWorkspaces)) {
    return false;
  }

  if (
    run.status === "suppressed" &&
    runs.some(
      (candidate) =>
        candidate.runId !== run.runId &&
        candidate.retryKind === "recovery" &&
        candidate.recovery?.runId === run.recovery?.runId &&
        new Date(candidate.updatedAt).getTime() >
          new Date(run.updatedAt).getTime() &&
        candidate.status !== "running" &&
        candidate.status !== "retrying"
    )
  ) {
    return false;
  }

  return (
    run.status === "suppressed" ||
    (run.retryKind === "recovery" &&
      (run.status === "running" || run.status === "retrying"))
  );
}

export function isRecoveryWorkspaceActionable(
  run: OrchestratorRunRecord,
  recovery: IncompleteTurnRecoveryInfo,
  issueWorkspaces: readonly IssueWorkspaceRecord[]
): boolean {
  const workspaceRecord = findRecoveryWorkspaceRecord(
    run,
    recovery,
    issueWorkspaces
  );

  return !workspaceRecord || workspaceRecord.status === "active";
}

function findRecoveryWorkspaceRecord(
  run: OrchestratorRunRecord,
  recovery: IncompleteTurnRecoveryInfo,
  issueWorkspaces: readonly IssueWorkspaceRecord[]
): IssueWorkspaceRecord | null {
  const projectWorkspaces = issueWorkspaces.filter(
    (workspace) => workspace.projectId === run.projectId
  );

  if (run.issueWorkspaceKey) {
    const byKey = projectWorkspaces.find(
      (workspace) => workspace.workspaceKey === run.issueWorkspaceKey
    );
    if (byKey) {
      return byKey;
    }
  }

  const byPath = projectWorkspaces.find(
    (workspace) =>
      workspace.repositoryPath === recovery.workspacePath ||
      workspace.workspacePath === recovery.workspacePath
  );
  if (byPath) {
    return byPath;
  }

  const bySubject = projectWorkspaces.find(
    (workspace) => workspace.issueSubjectId === run.issueSubjectId
  );
  if (bySubject) {
    return bySubject;
  }

  return (
    projectWorkspaces.find(
      (workspace) => workspace.issueIdentifier === recovery.issueIdentifier
    ) ?? null
  );
}

function aggregateTokenUsageByIssue(
  runs: OrchestratorRunRecord[]
): Map<string, NonNullable<OrchestratorRunRecord["tokenUsage"]>> {
  const totals = new Map<
    string,
    NonNullable<OrchestratorRunRecord["tokenUsage"]>
  >();

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
    cumulativeOutputTokens: cumulative?.outputTokens ?? tokenUsage.outputTokens,
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
  for (const run of runs) {
    if (run.tokenUsage) {
      inputTokens += run.tokenUsage.inputTokens;
      outputTokens += run.tokenUsage.outputTokens;
      totalTokens += run.tokenUsage.totalTokens;
    }
  }

  const runtimeMs = Array.from(latestSessionsByRunLifecycle(runs).values())
    .map((run) => runtimeMsForSnapshot(run, lastTickAt))
    .reduce((total, sessionRuntimeMs) => total + sessionRuntimeMs, 0);
  const secondsRunning = Math.max(0, Math.round(runtimeMs / 1000));

  return { inputTokens, outputTokens, totalTokens, secondsRunning };
}

function latestSessionsByRunLifecycle(
  runs: OrchestratorRunRecord[]
): Map<string, OrchestratorRunRecord> {
  const latestRuns = new Map<string, OrchestratorRunRecord>();

  for (const run of runs) {
    const key = `${run.projectId}:${run.issueId}:${run.createdAt}`;
    const current = latestRuns.get(key);
    if (
      !current ||
      new Date(run.updatedAt).getTime() >= new Date(current.updatedAt).getTime()
    ) {
      latestRuns.set(key, run);
    }
  }

  return latestRuns;
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
    run.completedAt ?? (run.status === "running" ? lastTickAt : run.updatedAt);
  const endedAtMs = new Date(endedAt).getTime();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return accumulatedRuntimeMs;
  }

  return accumulatedRuntimeMs + Math.max(0, endedAtMs - startedAtMs);
}

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
  summary: {
    dispatched: number;
    suppressed: number;
    recovered: number;
  };
  lastTickAt: string;
  lastError: string | null;
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
  const { workspace, activeRuns, summary, lastTickAt, lastError } = input;

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
  };
}

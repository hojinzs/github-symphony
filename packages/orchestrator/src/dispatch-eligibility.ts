import {
  isStateActive,
  issueRoutable,
  type IssueOrchestrationRecord,
  type OrchestratorRunRecord,
  type TrackedIssue,
  type WorkflowLifecycleConfig,
} from "@gh-symphony/core";

export function isIssueCandidateEligibleWithReason(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig
): {
  eligible: boolean;
  reason: "not_dispatchable" | "inactive_state" | "not_routable" | null;
} {
  if (!issue.dispatchable)
    return { eligible: false, reason: "not_dispatchable" };
  if (!isStateActive(issue.state, lifecycle)) {
    return { eligible: false, reason: "inactive_state" };
  }
  if (!issueRoutable(issue, lifecycle).routable) {
    return { eligible: false, reason: "not_routable" };
  }
  return { eligible: true, reason: null };
}

export function getConvergenceLockStatus(
  runs: readonly OrchestratorRunRecord[],
  issueId: string,
  issueState: string,
  issueUpdatedAt: string | null | undefined,
  options: { now?: Date; ttlMs?: number } = {}
): { run: OrchestratorRunRecord | null; expired: boolean } {
  const latestRun = latestRunForIssue(runs, issueId);
  if (
    latestRun?.runtimeSession?.exitClassification !== "convergence-detected" ||
    latestRun.issueState !== issueState
  ) {
    return { run: null, expired: false };
  }
  const convergedAtMs = parseConvergenceTimestampMs(
    latestRun.completedAt ?? latestRun.updatedAt
  );
  const issueUpdatedAtMs = issueUpdatedAt
    ? parseConvergenceTimestampMs(issueUpdatedAt)
    : null;
  const nowMs = (options.now ?? new Date()).getTime();
  const ttlMs = options.ttlMs ?? DEFAULT_CONVERGENCE_LOCK_TTL_MS;
  if (issueUpdatedAtMs !== null && issueUpdatedAtMs > convergedAtMs) {
    return { run: null, expired: false };
  }
  if (nowMs - convergedAtMs >= ttlMs) {
    return { run: latestRun, expired: true };
  }
  return { run: latestRun, expired: false };
}

export const DEFAULT_CONVERGENCE_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

export function resolveConvergenceLockTtlMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.SYMPHONY_CONVERGENCE_LOCK_TTL_MS);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONVERGENCE_LOCK_TTL_MS;
}

export function isIssueOrchestrationClaimedState(
  state: IssueOrchestrationRecord["state"]
): boolean {
  return state === "claimed" || state === "running" || state === "retry_queued";
}

export function isActiveRunRecordStatus(
  status: OrchestratorRunRecord["status"]
): boolean {
  return (
    status === "pending" ||
    status === "starting" ||
    status === "running" ||
    status === "retrying"
  );
}

function latestRunForIssue(
  runs: readonly OrchestratorRunRecord[],
  issueId: string
): OrchestratorRunRecord | null {
  return (
    runs
      .filter((run) => run.issueId === issueId)
      .sort(
        (left, right) =>
          (parseTimestampMs(right.updatedAt) ?? -Infinity) -
          (parseTimestampMs(left.updatedAt) ?? -Infinity)
      )[0] ?? null
  );
}

function parseConvergenceTimestampMs(value: string | null | undefined): number {
  if (!value) {
    throw new Error(
      "Convergence lock timestamp is missing; refusing to apply a silent fallback."
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Convergence lock timestamp is invalid: ${JSON.stringify(value)}`
    );
  }
  return parsed;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

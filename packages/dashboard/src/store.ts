import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  deriveIssueWorkspaceKeyFromIdentifier,
  isFileMissing,
  isMatchingIssueRun,
  mapIssueOrchestrationStateToStatus,
  parseRecentEvents,
  readJsonFile,
  safeReadDir,
  type IssueOrchestrationRecord,
  type IssueStatusEvent,
  type IssueStatusSnapshot,
  type OrchestratorRunRecord,
  type ProjectStatusSnapshot,
} from "@gh-symphony/core";

const DEFAULT_RECENT_EVENT_LIMIT = 20;
const RECENT_EVENT_CHUNK_SIZE = 4_096;
const MAX_RECENT_EVENT_SCAN_BYTES = 64 * 1_024;
const RUN_RECORD_LOAD_CONCURRENCY = 8;

export type DashboardIssueSnapshot = IssueOrchestrationRecord;

export type DashboardProjectStateSnapshot = ProjectStatusSnapshot & {
  completedCount: number;
  issues: DashboardIssueSnapshot[];
  alerts: DashboardAlert[];
};

export type DashboardAlert = {
  id: string;
  severity: "warning" | "critical";
  title: string;
  message: string;
};

export class DashboardFsReader {
  private readonly resolvedRuntimeRoot: string;

  constructor(
    readonly runtimeRoot: string,
    readonly projectId: string
  ) {
    assertValidDashboardProjectId(projectId);
    this.resolvedRuntimeRoot = resolve(runtimeRoot);
  }

  projectDir(): string {
    return join(this.resolvedRuntimeRoot, "projects", this.projectId);
  }

  runDir(runId: string): string {
    assertValidDashboardRunId(runId);
    return join(this.projectDir(), "runs", runId);
  }

  async loadProjectStatus(): Promise<ProjectStatusSnapshot | null> {
    return readJsonFile<ProjectStatusSnapshot>(
      join(this.projectDir(), "status.json")
    );
  }

  async loadProjectState(): Promise<DashboardProjectStateSnapshot | null> {
    const snapshot = await this.loadProjectStatus();
    if (!snapshot) {
      return null;
    }

    const issues = await this.loadProjectIssueOrchestrations();
    return {
      ...snapshot,
      completedCount: issues.filter((issue) => issue.completedOnce).length,
      issues,
      alerts: buildDashboardAlerts(snapshot),
    };
  }

  async loadProjectIssueOrchestrations(): Promise<IssueOrchestrationRecord[]> {
    const issues = await readJsonFile<IssueOrchestrationRecord[]>(
      join(this.projectDir(), "issues.json")
    );
    if (issues) {
      return issues.map((issue) => ({
        ...issue,
        completedOnce: issue.completedOnce ?? false,
        failureRetryCount: issue.failureRetryCount ?? 0,
      }));
    }

    const legacyLeases =
      (await readJsonFile<
        Array<{
          issueId: string;
          issueIdentifier: string;
          runId: string;
          status: "active" | "released";
          updatedAt: string;
        }>
      >(join(this.projectDir(), "leases.json"))) ?? [];

    return legacyLeases.map((lease) => ({
      issueId: lease.issueId,
      identifier: lease.issueIdentifier,
      workspaceKey: deriveIssueWorkspaceKeyFromIdentifier(
        lease.issueIdentifier
      ),
      completedOnce: false,
      failureRetryCount: 0,
      state: lease.status === "active" ? "claimed" : "released",
      currentRunId: lease.status === "active" ? lease.runId : null,
      retryEntry: null,
      updatedAt: lease.updatedAt,
    }));
  }

  async loadRun(runId: string): Promise<OrchestratorRunRecord | null> {
    return readJsonFile<OrchestratorRunRecord>(
      join(this.runDir(runId), "run.json")
    );
  }

  async loadAllRuns(): Promise<OrchestratorRunRecord[]> {
    const runIds = await safeReadDir(join(this.projectDir(), "runs"));
    const runs = await mapWithConcurrency(
      runIds,
      RUN_RECORD_LOAD_CONCURRENCY,
      (runId) => this.loadRun(runId)
    );
    return runs.filter((run): run is OrchestratorRunRecord => Boolean(run));
  }

  async loadRunsForIssue(
    issueId: string,
    issueIdentifier: string
  ): Promise<OrchestratorRunRecord[]> {
    const runIds = await safeReadDir(join(this.projectDir(), "runs"));
    const runs = await mapWithConcurrency(
      runIds,
      RUN_RECORD_LOAD_CONCURRENCY,
      async (runId) => {
        try {
          const run = await this.loadRun(runId);
          if (!run) {
            return null;
          }

          return run.issueId === issueId || run.issueIdentifier === issueIdentifier
            ? run
            : null;
        } catch (error) {
          if (isFileMissing(error)) {
            return null;
          }

          return null;
        }
      }
    );

    return runs.filter((run): run is OrchestratorRunRecord => Boolean(run));
  }

  async loadRecentRunEvents(
    runId: string,
    limit = DEFAULT_RECENT_EVENT_LIMIT
  ): Promise<IssueStatusEvent[]> {
    if (limit <= 0) {
      return [];
    }

    const path = join(this.runDir(runId), "events.ndjson");
    try {
      const handle = await open(path, "r");
      try {
        const stats = await handle.stat();
        let position = stats.size;
        let bytesScanned = 0;
        let newlineCount = 0;
        const chunks: Buffer[] = [];

        while (
          position > 0 &&
          bytesScanned < MAX_RECENT_EVENT_SCAN_BYTES &&
          newlineCount <= limit
        ) {
          const readSize = Math.min(
            position,
            RECENT_EVENT_CHUNK_SIZE,
            MAX_RECENT_EVENT_SCAN_BYTES - bytesScanned
          );
          position -= readSize;

          const chunk = Buffer.allocUnsafe(readSize);
          const { bytesRead } = await handle.read(chunk, 0, readSize, position);
          if (bytesRead === 0) {
            break;
          }
          const populatedChunk = chunk.subarray(0, bytesRead);
          chunks.unshift(populatedChunk);
          bytesScanned += bytesRead;
          newlineCount += countNewlines(populatedChunk);
        }

        return parseRecentEvents(
          Buffer.concat(chunks).toString("utf8"),
          limit,
          {
            allowPartialFirstLine: position > 0,
          }
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isFileMissing(error)) {
        return [];
      }

      throw error;
    }
  }
}

function buildDashboardAlerts(
  snapshot: ProjectStatusSnapshot
): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  const monitoring = snapshot.monitoring;

  if (snapshot.health === "degraded" || snapshot.lastError) {
    alerts.push({
      id: "project-health",
      severity: "critical",
      title: "Project health degraded",
      message: snapshot.lastError ?? "The orchestrator reported a degraded health state.",
    });
  }

  if (monitoring?.retryQueue.size) {
    alerts.push({
      id: "retry-queue",
      severity: monitoring.retryQueue.size >= 3 ? "critical" : "warning",
      title: "Retry queue active",
      message: `retryQueue=${monitoring.retryQueue.size}, nextRetryAt=${monitoring.retryQueue.nextRetryAt ?? "unknown"}`,
    });
  }

  if (monitoring?.stalledRuns.count) {
    alerts.push({
      id: "stalled-runs",
      severity: "critical",
      title: "Stalled runs detected",
      message: monitoring.stalledRuns.issueIdentifiers.join(", "),
    });
  }

  if (monitoring?.dispatch.starved) {
    alerts.push({
      id: "dispatch-starvation",
      severity: "critical",
      title: "Dispatch starvation detected",
      message: `unscheduledEligibleIssues=${monitoring.dispatch.unscheduledEligibleIssues ?? 0}, eligibleIssues=${monitoring.dispatch.eligibleIssues ?? 0}, consecutiveCycles=${monitoring.dispatch.starvationConsecutiveCycles}`,
    });
  }

  if (monitoring?.retryExhaustion.count) {
    alerts.push({
      id: "retry-exhaustion",
      severity: "critical",
      title: "Retry exhaustion detected",
      message: monitoring.retryExhaustion.issueIdentifiers.join(", "),
    });
  }

  const rateLimitAlert = resolveRateLimitAlert(snapshot.rateLimits);
  if (rateLimitAlert) {
    alerts.push(rateLimitAlert);
  }

  const heartbeat = monitoring?.heartbeat;
  if (heartbeat && heartbeat.maxAgeMs !== null) {
    const heartbeatAgeMinutes = heartbeat.maxAgeMs / 60_000;
    if (heartbeatAgeMinutes >= 10) {
      alerts.push({
        id: "heartbeat-stale",
        severity: heartbeatAgeMinutes >= 30 ? "critical" : "warning",
        title: "Turn heartbeat stale",
        message: `maxHeartbeatAgeMs=${heartbeat.maxAgeMs}, oldestLastEventAt=${heartbeat.oldestLastEventAt ?? "unknown"}`,
      });
    }
  }

  const trackerApi = monitoring?.trackerApi;
  if (trackerApi && trackerApi.availability !== "healthy") {
    alerts.push({
      id: "tracker-api",
      severity: trackerApi.availability === "down" ? "critical" : "warning",
      title: "Tracker API degraded",
      message: `availability=${trackerApi.availability}, errorRate=${trackerApi.errorRate.toFixed(3)}, consecutiveFailures=${trackerApi.consecutiveFailures}`,
    });
  }

  return alerts;
}

function resolveRateLimitAlert(
  rateLimits: ProjectStatusSnapshot["rateLimits"]
): DashboardAlert | null {
  if (
    !rateLimits ||
    typeof rateLimits.limit !== "number" ||
    typeof rateLimits.remaining !== "number" ||
    rateLimits.limit <= 0
  ) {
    return null;
  }

  const ratio = rateLimits.remaining / rateLimits.limit;
  if (ratio >= 0.2) {
    return null;
  }

  return {
    id: "rate-limit",
    severity: ratio < 0.1 ? "critical" : "warning",
    title: "Rate limit low",
    message: `remaining=${rateLimits.remaining}, limit=${rateLimits.limit}`,
  };
}

function countNewlines(chunk: Uint8Array): number {
  let count = 0;
  for (const byte of chunk) {
    if (byte === 0x0a) {
      count += 1;
    }
  }

  return count;
}

export async function statusForIssue(
  reader: DashboardFsReader,
  issueIdentifier: string
): Promise<IssueStatusSnapshot | null> {
  const issueRecords = await reader.loadProjectIssueOrchestrations();
  const issueRecord = issueRecords.find(
    (record) => record.identifier === issueIdentifier
  );
  if (!issueRecord) {
    return null;
  }

  const currentRunCandidate = issueRecord.currentRunId
    ? await reader.loadRun(issueRecord.currentRunId)
    : null;
  const currentRun = isMatchingIssueRun(
    currentRunCandidate,
    reader.projectId,
    issueRecord.issueId,
    issueIdentifier
  )
    ? currentRunCandidate
    : null;
  const issueRuns =
    currentRun === null
      ? await reader.loadRunsForIssue(issueRecord.issueId, issueIdentifier)
      : currentRun.tokenUsage
        ? await reader.loadRunsForIssue(issueRecord.issueId, issueIdentifier)
        : null;
  const resolvedRun =
    currentRun ?? findLatestRunForIssue(issueRuns ?? []);

  const recentEvents =
    resolvedRun === null
      ? []
      : await reader.loadRecentRunEvents(resolvedRun.runId);
  const cumulativeTokens = aggregateIssueTokenUsage(issueRuns ?? []);
  const latestEventMessage =
    recentEvents[recentEvents.length - 1]?.message ?? null;
  const currentAttempt =
    resolvedRun?.attempt ?? issueRecord.retryEntry?.attempt ?? 0;

  return {
    issue_identifier: issueRecord.identifier,
    issue_id: issueRecord.issueId,
    status:
      resolvedRun?.status ??
      mapIssueOrchestrationStateToStatus(issueRecord.state),
    workspace: {
      path: resolvedRun?.workingDirectory ?? null,
    },
    attempts: {
      restart_count: Math.max(0, currentAttempt - 1),
      current_retry_attempt: currentAttempt,
    },
    running:
      resolvedRun === null
        ? null
        : {
            session_id: resolvedRun.runtimeSession?.sessionId ?? null,
            turn_count: resolvedRun.turnCount ?? null,
            state: resolvedRun.issueState ?? null,
            started_at: resolvedRun.startedAt ?? null,
            last_event: resolvedRun.lastEvent ?? null,
            last_message: latestEventMessage,
            last_event_at: resolvedRun.lastEventAt ?? null,
            tokens: resolvedRun.tokenUsage
              ? {
                  input_tokens: resolvedRun.tokenUsage.inputTokens,
                  output_tokens: resolvedRun.tokenUsage.outputTokens,
                  total_tokens: resolvedRun.tokenUsage.totalTokens,
                  cumulative_input_tokens: cumulativeTokens.inputTokens,
                  cumulative_output_tokens: cumulativeTokens.outputTokens,
                  cumulative_total_tokens: cumulativeTokens.totalTokens,
                }
              : null,
          },
    retry:
      (resolvedRun?.nextRetryAt ?? issueRecord.retryEntry?.dueAt)
        ? {
            due_at:
              resolvedRun?.nextRetryAt ?? issueRecord.retryEntry?.dueAt ?? "",
            kind: resolvedRun?.retryKind ?? null,
            error:
              resolvedRun?.lastError ?? issueRecord.retryEntry?.error ?? null,
          }
        : null,
    logs: {
      codex_session_logs:
        resolvedRun === null
          ? []
          : [
              {
                label: "worker",
                path: join(reader.runDir(resolvedRun.runId), "worker.log"),
                url: null,
              },
            ],
    },
    recent_events: recentEvents,
    last_error: resolvedRun?.lastError ?? issueRecord.retryEntry?.error ?? null,
    tracked: {
      issue_orchestration_state: issueRecord.state,
      current_run_id: issueRecord.currentRunId,
      workspace_key: issueRecord.workspaceKey,
      completed_once: issueRecord.completedOnce,
      run_phase: resolvedRun?.runPhase ?? null,
      execution_phase: resolvedRun?.executionPhase ?? null,
    },
  };
}

function aggregateIssueTokenUsage(runs: OrchestratorRunRecord[]): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  return runs.reduce(
    (total, run) => ({
      inputTokens: total.inputTokens + (run.tokenUsage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (run.tokenUsage?.outputTokens ?? 0),
      totalTokens: total.totalTokens + (run.tokenUsage?.totalTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
  );
}

function findLatestRunForIssue(
  matchingRuns: OrchestratorRunRecord[]
): OrchestratorRunRecord | null {
  // If the tracked currentRunId is stale, fall back to a bounded-concurrency scan
  // across persisted runs rather than opening every run.json at once.
  const sortedRuns = [...matchingRuns]
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );

  return sortedRuns[0] ?? null;
}

export function assertValidDashboardProjectId(projectId: string): void {
  if (
    projectId.length === 0 ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\")
  ) {
    throw new Error(
      `Invalid project ID "${projectId}". Project IDs must not contain path separators or traversal segments.`
    );
  }
}

export function assertValidDashboardRunId(runId: string): void {
  if (
    runId.length === 0 ||
    runId === "." ||
    runId === ".." ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    throw new Error(
      `Invalid run ID "${runId}". Run IDs must not contain path separators or traversal segments.`
    );
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  };

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

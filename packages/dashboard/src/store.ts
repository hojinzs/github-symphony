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
    return join(this.projectDir(), "runs", runId);
  }

  async loadProjectStatus(): Promise<ProjectStatusSnapshot | null> {
    return readJsonFile<ProjectStatusSnapshot>(
      join(this.projectDir(), "status.json")
    );
  }

  async loadProjectIssueOrchestrations(): Promise<IssueOrchestrationRecord[]> {
    const issues =
      await readJsonFile<IssueOrchestrationRecord[]>(
        join(this.projectDir(), "issues.json")
      );
    if (issues) {
      return issues;
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
      state: lease.status === "active" ? "claimed" : "released",
      currentRunId: lease.status === "active" ? lease.runId : null,
      retryEntry: null,
      updatedAt: lease.updatedAt,
    }));
  }

  async loadRun(runId: string): Promise<OrchestratorRunRecord | null> {
    return readJsonFile<OrchestratorRunRecord>(join(this.runDir(runId), "run.json"));
  }

  async loadAllRuns(): Promise<OrchestratorRunRecord[]> {
    const runIds = await safeReadDir(join(this.projectDir(), "runs"));
    const runs = await Promise.all(runIds.map((runId) => this.loadRun(runId)));
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

        return parseRecentEvents(Buffer.concat(chunks).toString("utf8"), limit, {
          allowPartialFirstLine: position > 0,
        });
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
    : await findLatestRunForIssue(reader, issueRecord.issueId, issueIdentifier);

  const recentEvents =
    currentRun === null ? [] : await reader.loadRecentRunEvents(currentRun.runId);
  const latestEventMessage =
    recentEvents[recentEvents.length - 1]?.message ?? null;
  const currentAttempt =
    currentRun?.attempt ?? issueRecord.retryEntry?.attempt ?? 0;

  return {
    issue_identifier: issueRecord.identifier,
    issue_id: issueRecord.issueId,
    status:
      currentRun?.status ?? mapIssueOrchestrationStateToStatus(issueRecord.state),
    workspace: {
      path: currentRun?.workingDirectory ?? null,
    },
    attempts: {
      restart_count: Math.max(0, currentAttempt - 1),
      current_retry_attempt: currentAttempt,
    },
    running:
      currentRun === null
        ? null
        : {
            session_id: currentRun.runtimeSession?.sessionId ?? null,
            turn_count: currentRun.turnCount ?? null,
            state: currentRun.issueState ?? null,
            started_at: currentRun.startedAt ?? null,
            last_event: currentRun.lastEvent ?? null,
            last_message: latestEventMessage,
            last_event_at: currentRun.lastEventAt ?? null,
            tokens: currentRun.tokenUsage
              ? {
                  input_tokens: currentRun.tokenUsage.inputTokens,
                  output_tokens: currentRun.tokenUsage.outputTokens,
                  total_tokens: currentRun.tokenUsage.totalTokens,
                }
              : null,
          },
    retry:
      currentRun?.nextRetryAt ?? issueRecord.retryEntry?.dueAt
        ? {
            due_at: currentRun?.nextRetryAt ?? issueRecord.retryEntry?.dueAt ?? "",
            kind: currentRun?.retryKind ?? null,
            error: currentRun?.lastError ?? issueRecord.retryEntry?.error ?? null,
          }
        : null,
    logs: {
      codex_session_logs:
        currentRun === null
          ? []
          : [
              {
                label: "worker",
                path: join(reader.runDir(currentRun.runId), "worker.log"),
                url: null,
              },
            ],
    },
    recent_events: recentEvents,
    last_error: currentRun?.lastError ?? issueRecord.retryEntry?.error ?? null,
    tracked: {
      issue_orchestration_state: issueRecord.state,
      current_run_id: issueRecord.currentRunId,
      workspace_key: issueRecord.workspaceKey,
      run_phase: currentRun?.runPhase ?? null,
      execution_phase: currentRun?.executionPhase ?? null,
    },
  };
}

async function findLatestRunForIssue(
  reader: DashboardFsReader,
  issueId: string,
  issueIdentifier: string
): Promise<OrchestratorRunRecord | null> {
  const matchingRuns = (await reader.loadAllRuns())
    .filter((run) => run.issueId === issueId || run.issueIdentifier === issueIdentifier)
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );

  return matchingRuns[0] ?? null;
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

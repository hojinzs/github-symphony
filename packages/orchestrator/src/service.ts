import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_FAILURE_RETRIES,
  DEFAULT_WORKFLOW_LIFECYCLE,
  attributeDirtyWorkToIssue,
  buildHookEnv,
  buildIssueIdentityHeader,
  buildPromptVariables,
  buildProjectSnapshot,
  deriveIssueWorkspaceKey,
  deriveLegacyIssueWorkspaceKey,
  executeWorkspaceHook,
  isStateTerminal,
  isMatchingIssueRun,
  matchesWorkflowState,
  isOrchestratorChannelEvent,
  mapIssueOrchestrationStateToStatus,
  readEnvFile,
  renderPrompt,
  resolveWorkflowRuntimeCommand,
  resolveWorkflowRuntimeTimeouts,
  resolveIssueWorkspaceDirectory,
  scheduleRetryAt,
  type HookResult,
  type IssueOrchestrationRecord,
  type IssueStatusSnapshot,
  type IssueSubjectIdentity,
  type IssueWorkspaceRecord,
  type OrchestratorChannelEvent,
  type OrchestratorChannelSessionInfo,
  type OrchestratorRunRecord,
  type OrchestratorEvent,
  type OrchestratorStateStore,
  type OrchestratorProjectConfig,
  type OrchestratorTrackerDependencies,
  type OrchestratorTrackerAdapter,
  type IssueCommentCache,
  type ProjectItemsCache,
  type ProjectStatusSnapshot,
  type RepositoryRef,
  type RuntimeSessionRow,
  type SessionExitClassification,
  type TrackedIssue,
  type TrackedIssueList,
  type TrackerStateRequest,
  type TrackerStateResult,
  type WorkflowLifecycleConfig,
  type WorkflowResolution,
} from "@gh-symphony/core";
import {
  ensureIssueWorkspaceRepository,
  inspectIssueWorkspaceDirtyStatus,
  loadRepositoryWorkflow,
  quarantineIssueWorkspace,
  readGitCurrentBranch,
} from "./git.js";
import { OrchestratorFsStore } from "./fs-store.js";
import { PersistentIssueCommentCache } from "./issue-comment-cache.js";
import { resolveTrackerAdapter } from "./tracker-adapters.js";
import {
  hasConvergenceLockedRunForIssue,
  findActiveLinkedPullRequest,
  isActiveRunRecordStatus,
  isIssueCandidateEligibleWithReason,
  isIssueOrchestrationClaimedState,
} from "./explain.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const CONTINUATION_RETRY_DELAY_MS = 1_000;
const DEFAULT_WORKER_COMMAND = "node packages/worker/dist/index.js";
const DEFAULT_MAX_NONPRODUCTIVE_TURNS = 3;
const WORKER_TURN_LEASE_TTL_MS = 15_000;
const LOW_RATE_LIMIT_WARNING_THRESHOLD = 0.05;
const ADAPTIVE_RATE_LIMIT_FULL_SPEED_RATIO = 0.5;
const MAX_ADAPTIVE_POLL_INTERVAL_MULTIPLIER = 10;
const MAX_RECOVERY_DIRTY_FILES_IN_CONTEXT = 50;
const MAX_FAILURE_RETRIES_EXCEEDED_REASON = "max_failure_retries_exceeded";
const LINKED_PR_ACTIVE_ISSUE_INACTIVE_MARKER_PREFIX =
  "gh-symphony:linked-pr-active-while-issue-inactive";
const INHERITED_ENV_ALLOWLIST = new Set([
  "CI",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);
const WORKFLOW_HOOK_APPROVAL_ENV = "SYMPHONY_ALLOW_WORKFLOW_HOOKS";
const WORKFLOW_HOOK_ENV_ALLOWLIST_ENV = "SYMPHONY_WORKFLOW_HOOK_ENV_ALLOWLIST";

type ProjectWorkflowResolution = Awaited<
  ReturnType<typeof loadRepositoryWorkflow>
>;

const STUCK_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

type WorkerLogStreamLike = Pick<
  ReturnType<typeof createWriteStream>,
  "write" | "end" | "on"
>;

type IncompleteTurnRecoveryContext = NonNullable<
  OrchestratorRunRecord["recovery"]
>;

export type OrchestratorLogLevel = "normal" | "verbose";
type OrchestratorTickHandler = (
  snapshot: ProjectStatusSnapshot
) => void | Promise<void>;

function isUsableWorkflowResolution(resolution: WorkflowResolution): boolean {
  return resolution.isValid || resolution.usedLastKnownGood;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function resolveCanonicalSubjectIssues(
  issues: readonly TrackedIssue[]
): TrackedIssue[] {
  const pullRequestsById = new Map<string, TrackedIssue>();
  const pullRequestsByIdentifier = new Map<string, TrackedIssue>();

  for (const issue of issues) {
    if (issue.metadata.contentType !== "PullRequest") {
      continue;
    }

    pullRequestsById.set(issue.id, issue);
    pullRequestsByIdentifier.set(issue.identifier, issue);
  }

  const linkedPullRequestIds = new Set<string>();
  const linkedPullRequestIdentifiers = new Set<string>();
  const canonicalIssues: TrackedIssue[] = [];

  for (const issue of issues) {
    if (issue.metadata.contentType === "PullRequest") {
      continue;
    }

    const linkedPullRequests = Array.isArray(issue.metadata.linkedPullRequests)
      ? issue.metadata.linkedPullRequests
      : [];
    if (linkedPullRequests.length === 0) {
      canonicalIssues.push(issue);
      continue;
    }

    let mergedAnyProjectItem = false;
    const mergedLinkedPullRequests = linkedPullRequests.map((pullRequest) => {
      linkedPullRequestIds.add(pullRequest.id);
      linkedPullRequestIdentifiers.add(pullRequest.identifier);

      const projectPullRequest =
        pullRequestsById.get(pullRequest.id) ??
        pullRequestsByIdentifier.get(pullRequest.identifier);
      if (!projectPullRequest) {
        return pullRequest;
      }

      mergedAnyProjectItem = true;
      return {
        ...pullRequest,
        projectState: projectPullRequest.state,
        projectItemId: projectPullRequest.tracker.itemId,
        tracker: projectPullRequest.tracker,
        priority: projectPullRequest.priority,
      };
    });

    canonicalIssues.push(
      mergedAnyProjectItem
        ? {
            ...issue,
            metadata: {
              ...issue.metadata,
              linkedPullRequests: mergedLinkedPullRequests,
            },
          }
        : issue
    );
  }

  for (const pullRequest of issues) {
    if (pullRequest.metadata.contentType !== "PullRequest") {
      continue;
    }

    if (
      linkedPullRequestIds.has(pullRequest.id) ||
      linkedPullRequestIdentifiers.has(pullRequest.identifier)
    ) {
      continue;
    }

    canonicalIssues.push(pullRequest);
  }

  return canonicalIssues;
}

function matchesTargetIssueIdentifier(
  issue: TrackedIssue,
  issueIdentifier: string
): boolean {
  if (issue.identifier === issueIdentifier) {
    return true;
  }

  const linkedPullRequests = Array.isArray(issue.metadata.linkedPullRequests)
    ? issue.metadata.linkedPullRequests
    : [];
  return linkedPullRequests.some(
    (pullRequest) => pullRequest.identifier === issueIdentifier
  );
}

function resolvePullRequestBranchCheckoutTarget(
  issue: TrackedIssue
): { headRefName: string } | null {
  const pullRequest =
    issue.metadata.contentType === "PullRequest"
      ? (issue.metadata.pullRequest ?? issue.metadata.linkedPullRequests?.[0])
      : (issue.metadata.linkedPullRequests?.[0] ?? null);

  if (!pullRequest) {
    if (issue.metadata.contentType === "PullRequest") {
      throw new Error(
        `Cannot checkout pull request branch for ${issue.identifier}: missing pull request metadata.`
      );
    }

    return null;
  }

  const headRefName = pullRequest.headRefName?.trim();
  if (!headRefName) {
    throw new Error(
      `Cannot checkout pull request branch for ${pullRequest.identifier}: missing headRefName.`
    );
  }

  const headRepository = pullRequest.headRepository ?? null;
  const sameOwner =
    headRepository?.owner.toLowerCase() ===
    issue.repository.owner.toLowerCase();
  const sameName =
    headRepository?.name.toLowerCase() === issue.repository.name.toLowerCase();
  if (!headRepository || !sameOwner || !sameName) {
    const source = headRepository
      ? `${headRepository.owner}/${headRepository.name}`
      : "unknown fork";
    throw new Error(
      `Cannot checkout pull request branch for ${pullRequest.identifier}: fork pull requests are unsupported for automatic checkout/push (${source} -> ${issue.repository.owner}/${issue.repository.name}).`
    );
  }

  return { headRefName };
}

function buildLinkedPullRequestActiveAdvisoryMarker(
  issueId: string,
  pullRequestId: string
): string {
  return `<!-- ${LINKED_PR_ACTIVE_ISSUE_INACTIVE_MARKER_PREFIX} issue=${issueId} pr=${pullRequestId} -->`;
}

function buildLinkedPullRequestActiveAdvisoryBody(input: {
  marker: string;
  issue: TrackedIssue;
  linkedPullRequest: {
    identifier: string;
    projectState: string;
  };
  lifecycle: WorkflowLifecycleConfig;
}): string {
  const activeStates = input.lifecycle.activeStates
    .map((state) => `\`${state}\``)
    .join(" or ");

  return `${input.marker}

Linked PR card status alone does not trigger dispatch.

- Canonical Issue: ${input.issue.identifier} (${input.issue.state})
- Linked PR card: ${input.linkedPullRequest.identifier} (${input.linkedPullRequest.projectState})
- No worker was started for this PR card status change.

To request rework, move the canonical Issue card to ${activeStates}.`;
}

export class OrchestratorService {
  private readonly projectPollIntervals = new Map<string, number>();
  private readonly activeWorkerPids = new Set<number>();
  private readonly workerStderrBuffers = new Map<string, string>();
  private readonly workerStderrDecoders = new Map<string, StringDecoder>();
  private readonly lastKnownGoodWorkflows = new Map<
    string,
    WorkflowResolution
  >();
  private readonly lastTrackerRateLimitsByProject = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly issueCommentCaches = new Map<string, IssueCommentCache>();
  private workflowResolutionCache: Map<
    string,
    Promise<WorkflowResolution>
  > | null = null;
  private running = true;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;
  private reconcilePromise: Promise<void> = Promise.resolve();
  private reconcileRequested = false;
  private workerOrchestratorUrl: string | null = null;
  private workerOrchestratorToken: string | null = null;

  constructor(
    readonly store: OrchestratorStateStore,
    readonly projectConfig: OrchestratorProjectConfig,
    readonly dependencies: {
      fetchImpl?: typeof fetch;
      spawnImpl?: SpawnLike;
      now?: () => Date;
      concurrency?: number;
      pollIntervalMs?: number;
      retryBackoffMs?: number;
      /** @deprecated No longer used. Retry scheduling is governed by backoff policy only. */
      maxAttempts?: number;
      killImpl?: (pid: number, signal?: NodeJS.Signals) => void;
      isProcessRunning?: (pid: number) => boolean;
      waitImpl?: (ms: number) => Promise<void>;
      stderr?: Pick<NodeJS.WriteStream, "write">;
      createWriteStreamImpl?: (
        path: string,
        options: { flags: string }
      ) => WorkerLogStreamLike;
      logLevel?: OrchestratorLogLevel;
      onTick?: OrchestratorTickHandler;
      assignedOnly?: boolean;
    } = {}
  ) {}

  setWorkerOrchestratorUrl(url: string): void {
    this.workerOrchestratorUrl = url;
  }

  setWorkerOrchestratorToken(token: string): void {
    this.workerOrchestratorToken = token;
  }

  async acquireWorkerTurnLease(input: {
    issueId: string;
    runId: string;
    turn: number;
  }): Promise<
    { acquired: true; expiresAt: string } | { acquired: false; reason: string }
  > {
    return this.runSerialized(async () => {
      const issueRecords = await this.store.loadProjectIssueOrchestrations(
        this.projectConfig.projectId
      );
      const record = issueRecords.find(
        (candidate) => candidate.issueId === input.issueId
      );

      if (!record || record.state !== "running") {
        return { acquired: false, reason: "issue_not_running" };
      }
      if (record.currentRunId !== input.runId) {
        return { acquired: false, reason: "run_not_current" };
      }
      if (!Number.isSafeInteger(input.turn) || input.turn < 1) {
        return { acquired: false, reason: "invalid_turn" };
      }

      return {
        acquired: true,
        expiresAt: new Date(
          this.now().getTime() + WORKER_TURN_LEASE_TTL_MS
        ).toISOString(),
      };
    });
  }

  async requestTrackerState(input: {
    runId: string;
    request: TrackerStateRequest;
  }): Promise<TrackerStateResult> {
    return this.runSerialized(async () => {
      const rejected = (error: string): TrackerStateResult => ({
        ok: false,
        outcome: "rejected",
        state: null,
        expectedState:
          input.request.type === "transition-request"
            ? input.request.expectedState
            : null,
        targetState:
          input.request.type === "transition-request"
            ? input.request.targetState
            : null,
        reason:
          input.request.type === "transition-request"
            ? input.request.reason
            : null,
        rateLimits: null,
        error,
      });
      const run = await this.store.loadRun(
        input.runId,
        this.projectConfig.projectId
      );
      if (!run) {
        return rejected("run_not_found");
      }

      const issueRecords = await this.store.loadProjectIssueOrchestrations(
        this.projectConfig.projectId
      );
      const issueRecord = issueRecords.find(
        (candidate) => candidate.issueId === run.issueId
      );
      if (
        !issueRecord ||
        issueRecord.state !== "running" ||
        issueRecord.currentRunId !== run.runId ||
        !isActiveRunRecordStatus(run.status)
      ) {
        const result = rejected("run_not_current");
        await this.appendTrackerStateEvent(run, input.request, result);
        return result;
      }

      const invalidRequest = validateTrackerStateRequest(input.request);
      if (invalidRequest) {
        const result = rejected(invalidRequest);
        await this.appendTrackerStateEvent(run, input.request, result);
        return result;
      }

      const trackerAdapter = resolveTrackerAdapter(this.projectConfig.tracker);
      if (!trackerAdapter.requestState) {
        const result = rejected("tracker_state_requests_unsupported");
        await this.appendTrackerStateEvent(run, input.request, result);
        return result;
      }

      let canonicalItemId = run.trackerItemId?.trim() ?? "";
      try {
        if (!canonicalItemId) {
          const refreshed = await trackerAdapter.fetchIssueStatesByIds(
            this.projectConfig,
            [run.issueSubjectId],
            this.createTrackerDependencies()
          );
          canonicalItemId =
            refreshed.find((issue) => issue.id === run.issueSubjectId)?.tracker
              .itemId ?? "";
          if (!canonicalItemId) {
            const result = rejected("canonical_tracker_item_missing");
            await this.appendTrackerStateEvent(run, input.request, result);
            return result;
          }
        }

        const result = await trackerAdapter.requestState(
          this.projectConfig,
          {
            issueSubjectId: run.issueSubjectId,
            itemId: canonicalItemId,
            request: input.request,
          },
          this.createTrackerDependencies()
        );
        const nowIso = this.now().toISOString();
        await this.store.saveRun({
          ...run,
          trackerItemId: canonicalItemId,
          issueState: result.state ?? run.issueState,
          updatedAt: nowIso,
          lastEvent:
            input.request.type === "transition-request"
              ? "tracker-transition"
              : "tracker-state-read",
          lastEventAt: nowIso,
          rateLimits: result.rateLimits ?? run.rateLimits ?? null,
          lastError: result.ok
            ? run.lastError
            : (result.error ?? run.lastError),
        });
        await this.appendTrackerStateEvent(
          { ...run, trackerItemId: canonicalItemId },
          input.request,
          result
        );
        this.rememberTrackerRateLimits(
          this.projectConfig.projectId,
          result.rateLimits
        );
        return result;
      } catch (error) {
        const rateLimits = extractTrackerRateLimitsFromError(error);
        const result: TrackerStateResult = {
          ...rejected(this.formatErrorMessage(error)),
          outcome: "failed",
          rateLimits,
        };
        const nowIso = this.now().toISOString();
        await this.store.saveRun({
          ...run,
          trackerItemId: canonicalItemId,
          updatedAt: nowIso,
          lastEvent: "tracker-transition-failed",
          lastEventAt: nowIso,
          rateLimits: rateLimits ?? run.rateLimits ?? null,
          lastError: result.error,
        });
        await this.appendTrackerStateEvent(
          { ...run, trackerItemId: canonicalItemId },
          input.request,
          result
        );
        return result;
      }
    });
  }

  private async appendTrackerStateEvent(
    run: OrchestratorRunRecord,
    request: TrackerStateRequest,
    result: TrackerStateResult
  ): Promise<void> {
    await this.store.appendRunEvent(run.runId, {
      at: this.now().toISOString(),
      event: "tracker.state",
      projectId: run.projectId,
      runId: run.runId,
      tracker: {
        adapter: this.projectConfig.tracker.adapter,
      },
      issue: {
        identifier: run.issueIdentifier,
        id: run.issueSubjectId,
      },
      requestType: request.type,
      expectedState: result.expectedState,
      targetState: result.targetState,
      confirmedState: result.state,
      outcome: result.outcome,
      reason: result.reason,
      error: result.error,
      rateLimits: result.rateLimits,
    });
  }

  private async returnConvergedIssueToRetryableState(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord,
    trackerDependencies: OrchestratorTrackerDependencies
  ): Promise<{ confirmed: boolean; state: string | null }> {
    const resolution = await this.loadProjectWorkflow(
      tenant,
      run.repository
    ).catch(() => null);
    if (!resolution || !isUsableWorkflowResolution(resolution)) {
      return { confirmed: false, state: null };
    }

    const retryableState = resolution.workflow.tracker.activeStates[0]?.trim();
    if (
      !retryableState ||
      matchesWorkflowState(run.issueState, [retryableState])
    ) {
      return { confirmed: false, state: null };
    }

    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    if (!trackerAdapter.requestState) {
      return { confirmed: false, state: null };
    }

    let canonicalItemId = run.trackerItemId?.trim() ?? "";
    try {
      if (!canonicalItemId) {
        const refreshed = await trackerAdapter.fetchIssueStatesByIds(
          tenant,
          [run.issueSubjectId],
          trackerDependencies
        );
        canonicalItemId =
          refreshed.find((issue) => issue.id === run.issueSubjectId)?.tracker
            .itemId ?? "";
      }
      if (!canonicalItemId) {
        return { confirmed: false, state: null };
      }

      const request: TrackerStateRequest = {
        type: "transition-request",
        expectedState: run.issueState,
        targetState: retryableState,
        reason: "Clean-workspace convergence requires a fresh retry cycle.",
      };
      const result = await trackerAdapter.requestState(
        tenant,
        {
          issueSubjectId: run.issueSubjectId,
          itemId: canonicalItemId,
          request,
        },
        trackerDependencies
      );
      await this.appendTrackerStateEvent(
        { ...run, trackerItemId: canonicalItemId },
        request,
        result
      );
      this.rememberTrackerRateLimits(tenant.projectId, result.rateLimits);
      return {
        confirmed:
          result.ok &&
          result.outcome === "confirmed" &&
          result.state !== null &&
          matchesWorkflowState(result.state, [retryableState]),
        state: result.state,
      };
    } catch (error) {
      const request: TrackerStateRequest = {
        type: "transition-request",
        expectedState: run.issueState,
        targetState: retryableState,
        reason: "Clean-workspace convergence requires a fresh retry cycle.",
      };
      await this.appendTrackerStateEvent(run, request, {
        ok: false,
        outcome: "failed",
        state: null,
        expectedState: run.issueState,
        targetState: retryableState,
        reason: request.reason,
        rateLimits: extractTrackerRateLimitsFromError(error),
        error: this.formatErrorMessage(error),
      });
      return { confirmed: false, state: null };
    }
  }

  async run(
    options: {
      issueIdentifier?: string;
      once?: boolean;
    } = {}
  ): Promise<void> {
    this.running = true;
    await this.runSerialized(() =>
      this.performStartupCleanup(this.createTrackerDependencies())
    );

    while (this.running) {
      try {
        const snapshot = await this.runOnceInternal(
          options.issueIdentifier,
          this.createTrackerDependencies()
        );
        await this.notifyTick(snapshot);
      } catch (error) {
        if (options.once) {
          throw error;
        }

        this.writeStderr(
          `[orchestrator] run loop failed for ${this.projectConfig.projectId}: ${this.formatErrorMessage(error)}`
        );
      }

      if (options.once || !this.running) {
        return;
      }

      await this.waitForNextPoll();
    }
  }

  async runOnce(
    options: {
      issueIdentifier?: string;
    } = {}
  ): Promise<ProjectStatusSnapshot> {
    return this.runOnceInternal(
      options.issueIdentifier,
      this.createTrackerDependencies()
    );
  }

  async status(): Promise<ProjectStatusSnapshot | null> {
    return this.store.loadProjectStatus(this.projectConfig.projectId);
  }

  async statusForIssue(
    issueIdentifier: string
  ): Promise<IssueStatusSnapshot | null> {
    const issueRecords = await this.store.loadProjectIssueOrchestrations(
      this.projectConfig.projectId
    );
    const issueRecord = issueRecords.find(
      (record) => record.identifier === issueIdentifier
    );
    if (!issueRecord) {
      return null;
    }

    const currentRunCandidate = issueRecord.currentRunId
      ? await this.store.loadRun(
          issueRecord.currentRunId,
          this.projectConfig.projectId
        )
      : null;
    const currentRun = isMatchingIssueRun(
      currentRunCandidate,
      issueRecord.issueId,
      issueIdentifier
    )
      ? currentRunCandidate
      : await this.findLatestRunForIssue(issueRecord.issueId, issueIdentifier);

    const recentEvents =
      currentRun === null
        ? []
        : await this.store.loadRecentRunEvents(
            currentRun.runId,
            20,
            currentRun.projectId
          );
    const latestEventMessage =
      recentEvents[recentEvents.length - 1]?.message ?? null;
    const currentAttempt =
      currentRun?.attempt ?? issueRecord.retryEntry?.attempt ?? 0;

    return {
      issue_identifier: issueRecord.identifier,
      issue_id: issueRecord.issueId,
      status:
        currentRun?.status ??
        mapIssueOrchestrationStateToStatus(issueRecord.state),
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
        (currentRun?.nextRetryAt ?? issueRecord.retryEntry?.dueAt)
          ? {
              due_at:
                currentRun?.nextRetryAt ?? issueRecord.retryEntry?.dueAt ?? "",
              kind: currentRun?.retryKind ?? null,
              error:
                currentRun?.lastError ?? issueRecord.retryEntry?.error ?? null,
            }
          : null,
      recovery: currentRun?.recovery ?? null,
      logs: {
        codex_session_logs:
          currentRun === null
            ? []
            : [
                {
                  label: "worker",
                  path: join(
                    this.store.runDir(currentRun.runId, currentRun.projectId),
                    "worker.log"
                  ),
                  url: null,
                },
              ],
      },
      recent_events: recentEvents,
      last_error:
        currentRun?.lastError ?? issueRecord.retryEntry?.error ?? null,
      tracked: {
        issue_orchestration_state: issueRecord.state,
        current_run_id: issueRecord.currentRunId,
        workspace_key: issueRecord.workspaceKey,
        run_phase: currentRun?.runPhase ?? null,
        execution_phase: currentRun?.executionPhase ?? null,
      },
    };
  }

  async recover(): Promise<ProjectStatusSnapshot> {
    return this.runOnce();
  }

  requestReconcile(): void {
    this.reconcileRequested = true;
    this.cancelPendingSleep();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      this.running = false;
      this.cancelPendingSleep();

      const workerPids = [...this.activeWorkerPids];
      for (const pid of workerPids) {
        this.sendSignal(pid, "SIGTERM");
      }

      if (workerPids.length === 0) {
        return;
      }

      let waitedMs = 0;
      while (this.activeWorkerPids.size > 0 && waitedMs < 10_000) {
        this.pruneExitedWorkerPids();
        if (this.activeWorkerPids.size === 0) {
          return;
        }
        await (this.dependencies.waitImpl ?? wait)(100);
        waitedMs += 100;
      }

      for (const pid of [...this.activeWorkerPids]) {
        if (!this.isProcessRunning(pid)) {
          this.retireWorkerPid(pid);
          continue;
        }

        this.sendSignal(pid, "SIGKILL");
        this.retireWorkerPid(pid);
      }
    })();

    return this.shutdownPromise;
  }

  getEffectivePollIntervalMs(): number {
    if (this.dependencies.pollIntervalMs) {
      return this.dependencies.pollIntervalMs;
    }

    const configuredIntervals = [...this.projectPollIntervals.values()].filter(
      (value) => Number.isFinite(value) && value > 0
    );
    return configuredIntervals.length
      ? Math.min(...configuredIntervals)
      : DEFAULT_POLL_INTERVAL_MS;
  }

  private async reconcileProject(
    tenant: OrchestratorProjectConfig,
    issueIdentifier?: string,
    trackerDependencies: OrchestratorTrackerDependencies = {}
  ): Promise<ProjectStatusSnapshot> {
    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const now = this.now();
    let lastError: string | null = null;
    let dispatched = 0;
    let suppressed = 0;
    let recovered = 0;
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    let rateLimits: Record<string, unknown> | null = null;
    let trackerRateLimits: Record<string, unknown> | null = null;

    let issueRecords = await this.store.loadProjectIssueOrchestrations(
      tenant.projectId
    );
    const allRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.projectId === tenant.projectId
    );
    const activeRuns = allRuns.filter((run) =>
      isActiveRunRecordStatus(run.status)
    );
    for (const run of activeRuns) {
      const outcome = await this.reconcileRun(
        tenant,
        run,
        issueRecords,
        trackerDependencies
      );
      issueRecords = outcome.issueRecords;
      if (outcome.recovered) {
        recovered += 1;
      }
    }
    const reconciledRuns = (await this.store.loadAllRuns()).filter(
      (run) =>
        run.projectId === tenant.projectId &&
        isActiveRunRecordStatus(run.status)
    );
    const projectRunsAfterReconcile = (await this.store.loadAllRuns()).filter(
      (run) => run.projectId === tenant.projectId
    );
    rateLimits = resolveProjectRateLimits(reconciledRuns, []);

    try {
      pollIntervalMs = await this.loadProjectPollInterval(tenant);
      const currentActiveRuns = (await this.store.loadAllRuns()).filter(
        (run) =>
          run.projectId === tenant.projectId &&
          isActiveRunRecordStatus(run.status)
      );
      const candidateTrackerDependencies =
        await this.resolveCandidateTrackerDependencies(
          tenant,
          trackerDependencies
        );
      const issues = await trackerAdapter.listIssues(
        tenant,
        candidateTrackerDependencies
      );
      const canonicalIssues = resolveCanonicalSubjectIssues(issues);
      // `canonicalIssues`로 맵을 무조건 시딩하므로 기존 두 번째 역순 머지
      // 루프는 불필요하다. 시딩이 조건부가 되면 우선순위를 다시 검토해야 한다.
      const trackedIssuesByIdentifier = new Map<string, TrackedIssue>(
        canonicalIssues.map((issue) => [issue.identifier, issue])
      );
      const missingLinearActiveIssueIds =
        tenant.tracker.adapter === "linear"
          ? [
              ...new Set(
                currentActiveRuns
                  .filter(
                    (run) => !trackedIssuesByIdentifier.has(run.issueIdentifier)
                  )
                  .map((run) => run.issueId)
              ),
            ]
          : [];
      const supplementalLinearIssues =
        missingLinearActiveIssueIds.length > 0
          ? await trackerAdapter.fetchIssueStatesByIds(
              tenant,
              missingLinearActiveIssueIds,
              trackerDependencies
            )
          : [];
      const supplementalLinearIssueIdentifiers = new Set<string>();
      for (const issue of supplementalLinearIssues) {
        if (!trackedIssuesByIdentifier.has(issue.identifier)) {
          trackedIssuesByIdentifier.set(issue.identifier, issue);
          supplementalLinearIssueIdentifiers.add(issue.identifier);
        }
      }
      const supplementalLinearRateLimits = getTrackedIssueListRateLimits(
        supplementalLinearIssues
      );
      let supplementalLinearRateLimitsRecorded = false;
      const syncedActiveRuns: OrchestratorRunRecord[] = [];
      for (const run of currentActiveRuns) {
        const currentIssue = trackedIssuesByIdentifier.get(run.issueIdentifier);
        if (
          currentIssue &&
          supplementalLinearIssueIdentifiers.has(run.issueIdentifier)
        ) {
          const eventRateLimits =
            supplementalLinearRateLimits &&
            !supplementalLinearRateLimitsRecorded
              ? supplementalLinearRateLimits
              : supplementalLinearRateLimits
                ? null
                : (currentIssue.rateLimits ?? null);
          supplementalLinearRateLimitsRecorded ||=
            supplementalLinearRateLimits !== null;
          await this.store.appendRunEvent(run.runId, {
            at: now.toISOString(),
            event: "tracker.fetchByIds",
            projectId: tenant.projectId,
            ...buildStructuredTrackerEventMetadata(tenant, currentIssue),
            rateLimits: eventRateLimits,
          });
        }
        if (!currentIssue || currentIssue.state === run.issueState) {
          syncedActiveRuns.push(run);
          continue;
        }

        const updatedRun: OrchestratorRunRecord = {
          ...run,
          issueState: currentIssue.state,
          updatedAt: now.toISOString(),
        };
        await this.store.saveRun(updatedRun);
        syncedActiveRuns.push(updatedRun);
      }
      const {
        candidates: trackedActionableIssues,
        lifecyclesByIssueIdentifier,
      } = await this.resolveActionableCandidates(tenant, canonicalIssues);
      const resolveTrackedIssueLifecycle = async (
        issue: TrackedIssue
      ): Promise<WorkflowLifecycleConfig | null> => {
        const cached = lifecyclesByIssueIdentifier.get(issue.identifier);
        if (cached) {
          return cached;
        }
        const resolved = await this.resolveIssueLifecycle(tenant, issue);
        if (resolved) {
          lifecyclesByIssueIdentifier.set(issue.identifier, resolved);
        }
        return resolved;
      };
      const actionableCandidates = issueIdentifier
        ? trackedActionableIssues.filter((issue: TrackedIssue) =>
            matchesTargetIssueIdentifier(issue, issueIdentifier)
          )
        : trackedActionableIssues;
      const targetedIssues = issueIdentifier
        ? canonicalIssues.filter((issue: TrackedIssue) =>
            matchesTargetIssueIdentifier(issue, issueIdentifier)
          )
        : canonicalIssues;
      await this.publishLinkedPullRequestActiveAdvisories(
        tenant,
        trackerAdapter,
        targetedIssues,
        trackerDependencies
      );
      rateLimits = resolveProjectRateLimits(
        syncedActiveRuns,
        trackedIssuesByIdentifier.values(),
        getTrackedIssueListRateLimits(issues) ?? supplementalLinearRateLimits
      );
      trackerRateLimits = resolveTrackerRateLimits(
        trackedIssuesByIdentifier.values(),
        getTrackedIssueListRateLimits(issues) ?? supplementalLinearRateLimits
      );
      this.rememberTrackerRateLimits(tenant.projectId, trackerRateLimits);
      const concurrency = await this.getProjectConcurrency(tenant);
      const currentlyActive = issueRecords.filter((record) =>
        isIssueOrchestrationClaimedState(record.state)
      ).length;
      const availableSlots = Math.max(0, concurrency - currentlyActive);
      const latestRunsByIssueId = buildLatestRunMapByIssueId(
        projectRunsAfterReconcile
      );

      const unscheduledCandidates = actionableCandidates.filter((issue) => {
        if (
          hasConvergenceLockedRunForIssue(
            projectRunsAfterReconcile,
            issue.id,
            issue.state,
            issue.updatedAt
          )
        ) {
          return false;
        }

        return !issueRecords.some(
          (record) =>
            record.issueId === issue.id &&
            isIssueOrchestrationClaimedState(record.state)
        );
      });

      // Sort candidates by priority (asc, null last) → createdAt (oldest) → identifier (lexicographic)
      const sortedCandidates = sortCandidatesForDispatch(unscheduledCandidates);
      const listRateLimits = getTrackedIssueListRateLimits(issues);
      let listRateLimitsRecorded = false;

      // Count active runs by state for per-state concurrency limits
      const activeByState = new Map<string, number>();
      for (const run of syncedActiveRuns) {
        const state = run.issueState;
        const count = activeByState.get(state) ?? 0;
        activeByState.set(state, count + 1);
      }

      // Load per-state concurrency limits from workflow config
      const maxConcurrentByState =
        await this.loadProjectMaxConcurrentByState(tenant);

      let slotsRemaining = availableSlots;
      for (const issue of sortedCandidates) {
        if (this.shuttingDown) {
          break;
        }
        if (slotsRemaining <= 0) break;
        if (
          await this.isFailureRetrySuppressedIssue(
            tenant,
            issue,
            issueRecords,
            latestRunsByIssueId.get(issue.id) ?? null
          )
        ) {
          continue;
        }
        // Per-state concurrency check: skip if state limit reached
        const stateLimit = maxConcurrentByState[issue.state];
        if (stateLimit !== undefined) {
          const activeInState = activeByState.get(issue.state) ?? 0;
          if (activeInState >= stateLimit) {
            continue;
          }
        }

        const preferredWorkspaceKey = deriveIssueWorkspaceKey(
          {
            adapter: issue.tracker.adapter,
            issueSubjectId: issue.id,
          },
          issue.identifier
        );
        const recoveryContext = await this.resolveIncompleteTurnRecoveryContext(
          tenant,
          issue,
          latestRunsByIssueId.get(issue.id) ?? null,
          preferredWorkspaceKey
        );
        issueRecords = upsertIssueOrchestration(issueRecords, {
          issueId: issue.id,
          identifier: issue.identifier,
          workspaceKey: preferredWorkspaceKey,
          state: "claimed",
          failureRetryCount: 0,
          currentRunId: null,
          retryEntry: null,
          updatedAt: now.toISOString(),
        });
        await this.store.saveProjectIssueOrchestrations(
          tenant.projectId,
          issueRecords
        );
        let run: OrchestratorRunRecord;
        let preparedRun: OrchestratorRunRecord | null = null;
        try {
          run = await this.startRun(tenant, issue, {
            recovery: recoveryContext,
            onPrepared: async (candidate) => {
              preparedRun = candidate;
              issueRecords = upsertIssueOrchestration(issueRecords, {
                issueId: candidate.issueId,
                identifier: candidate.issueIdentifier,
                workspaceKey:
                  candidate.issueWorkspaceKey ?? preferredWorkspaceKey,
                state: "running",
                currentRunId: candidate.runId,
                retryEntry: null,
                updatedAt: now.toISOString(),
              });
              await this.store.saveRun(candidate);
              await this.store.saveProjectIssueOrchestrations(
                tenant.projectId,
                issueRecords
              );
            },
          });
        } catch (error) {
          const failedPreparedRun = preparedRun as OrchestratorRunRecord | null;
          if (failedPreparedRun) {
            await this.store.saveRun({
              ...failedPreparedRun,
              status: "failed",
              completedAt: now.toISOString(),
              updatedAt: now.toISOString(),
              lastError: `Worker spawn failed: ${this.formatErrorMessage(error)}`,
            });
          }
          issueRecords = releaseIssueOrchestration(issueRecords, issue.id, now);
          await this.store.saveProjectIssueOrchestrations(
            tenant.projectId,
            issueRecords
          );
          throw error;
        }
        issueRecords = upsertIssueOrchestration(issueRecords, {
          issueId: run.issueId,
          identifier: run.issueIdentifier,
          workspaceKey: run.issueWorkspaceKey ?? preferredWorkspaceKey,
          state: "running",
          currentRunId: run.runId,
          retryEntry: null,
          updatedAt: now.toISOString(),
        });
        await this.store.saveRun(run);
        await this.store.saveProjectIssueOrchestrations(
          tenant.projectId,
          issueRecords
        );
        const eventRateLimits =
          listRateLimits && !listRateLimitsRecorded
            ? listRateLimits
            : listRateLimits
              ? null
              : (issue.rateLimits ?? null);
        listRateLimitsRecorded ||= listRateLimits !== null;
        await this.store.appendRunEvent(run.runId, {
          at: now.toISOString(),
          event: "tracker.list",
          projectId: tenant.projectId,
          ...buildStructuredTrackerEventMetadata(tenant, issue),
          rateLimits: eventRateLimits,
        });
        await this.store.appendRunEvent(run.runId, {
          at: now.toISOString(),
          event: "run-dispatched",
          projectId: tenant.projectId,
          issueIdentifier: issue.identifier,
          issueId: run.issueId,
          issueState: issue.state,
          ...buildStructuredTrackerEventMetadata(tenant, issue),
        });
        this.logVerbose(
          `[dispatch] Issue ${issue.identifier} → run ${run.runId}`
        );
        dispatched += 1;
        slotsRemaining -= 1;
        activeByState.set(
          issue.state,
          (activeByState.get(issue.state) ?? 0) + 1
        );
      }

      if (listRateLimits && !listRateLimitsRecorded) {
        const activeRun = syncedActiveRuns[0];
        const activeIssue = activeRun
          ? trackedIssuesByIdentifier.get(activeRun.issueIdentifier)
          : null;
        if (activeRun && activeIssue) {
          await this.store.appendRunEvent(activeRun.runId, {
            at: now.toISOString(),
            event: "tracker.list",
            projectId: tenant.projectId,
            ...buildStructuredTrackerEventMetadata(tenant, activeIssue),
            rateLimits: listRateLimits,
          });
          listRateLimitsRecorded = true;
        }
      }

      for (const issueRecord of issueRecords) {
        if (!isIssueOrchestrationClaimedState(issueRecord.state)) {
          continue;
        }

        const persistedRun = issueRecord.currentRunId
          ? await this.store.loadRun(issueRecord.currentRunId, tenant.projectId)
          : null;
        const activeRun =
          syncedActiveRuns.find((run) =>
            isMatchingIssueRun(run, issueRecord.issueId, issueRecord.identifier)
          ) ?? persistedRun;
        const issue = trackedIssuesByIdentifier.get(issueRecord.identifier);
        if (!issue) {
          if (
            !activeRun ||
            activeRun.processId === null ||
            !this.isProcessRunning(activeRun.processId)
          ) {
            continue;
          }
          const activeWorkerPid = activeRun.processId;
          this.sendSignal(activeWorkerPid, "SIGTERM");
          this.retireWorkerPid(activeWorkerPid);
          const recovery = await this.classifyIncompleteTurnDirtyWorkspace(
            tenant,
            activeRun,
            now
          );
          const suppressedRun: OrchestratorRunRecord = {
            ...activeRun,
            status: "suppressed",
            processId: null,
            completedAt: now.toISOString(),
            updatedAt: now.toISOString(),
            runPhase: "canceled_by_reconciliation",
            runtimeSession: recovery
              ? buildRuntimeSession(
                  activeRun.runtimeSession,
                  recovery.sessionId,
                  recovery.threadId,
                  "completed",
                  activeRun.runtimeSession?.startedAt ??
                    activeRun.startedAt ??
                    now.toISOString(),
                  now.toISOString(),
                  "incomplete-turn-dirty-workspace"
                )
              : activeRun.runtimeSession,
            recovery,
            lastError: recovery
              ? "Run suppressed with recoverable incomplete-turn dirty workspace."
              : "Run suppressed because the tracker issue is no longer tracked.",
          };
          await this.store.saveRun(suppressedRun);
          this.logVerbose(
            `[run-completed] ${suppressedRun.runId} status=${suppressedRun.status}`
          );
          issueRecords = releaseIssueOrchestration(
            issueRecords,
            issueRecord.issueId,
            now
          );
          suppressed += 1;
          continue;
        }
        const resolvedIssue = trackedActionableIssues.find(
          (candidate) => candidate.identifier === issue.identifier
        );
        if (resolvedIssue) {
          continue;
        }

        if (activeRun?.processId) {
          this.sendSignal(activeRun.processId, "SIGTERM");
          this.retireWorkerPid(activeRun.processId);
        }
        if (activeRun) {
          const issueLifecycle = await resolveTrackedIssueLifecycle(issue);
          const terminalState =
            !isArchivedProjectItem(issue) &&
            issueLifecycle !== null &&
            isStateTerminal(issue.state, issueLifecycle);
          const recovery = terminalState
            ? null
            : await this.classifyIncompleteTurnDirtyWorkspace(
                tenant,
                activeRun,
                now
              );
          const suppressedRun: OrchestratorRunRecord = {
            ...activeRun,
            status: "suppressed",
            processId: null,
            completedAt: now.toISOString(),
            updatedAt: now.toISOString(),
            runPhase: "canceled_by_reconciliation",
            runtimeSession: recovery
              ? buildRuntimeSession(
                  activeRun.runtimeSession,
                  recovery.sessionId,
                  recovery.threadId,
                  "completed",
                  activeRun.runtimeSession?.startedAt ??
                    activeRun.startedAt ??
                    now.toISOString(),
                  now.toISOString(),
                  "incomplete-turn-dirty-workspace"
                )
              : activeRun.runtimeSession,
            recovery,
            lastError: recovery
              ? "Run suppressed with recoverable incomplete-turn dirty workspace."
              : terminalState
                ? "Run suppressed because the tracker issue moved to a terminal state."
                : "Run suppressed because the tracker state is no longer actionable.",
          };
          await this.store.saveRun(suppressedRun);
          this.logVerbose(
            `[run-completed] ${suppressedRun.runId} status=${suppressedRun.status}`
          );
        }
        issueRecords = releaseIssueOrchestration(
          issueRecords,
          issueRecord.issueId,
          now
        );
        suppressed += 1;
      }

      const terminalIssuesByIdentifier = new Map<string, TrackedIssue>();
      for (const issue of trackedIssuesByIdentifier.values()) {
        const issueLifecycle = await resolveTrackedIssueLifecycle(issue);
        if (
          isArchivedProjectItem(issue) ||
          issueLifecycle === null ||
          !isStateTerminal(issue.state, issueLifecycle)
        ) {
          continue;
        }
        terminalIssuesByIdentifier.set(issue.identifier, issue);
      }

      for (const issue of terminalIssuesByIdentifier.values()) {
        await this.cleanupTerminalIssueWorkspace(tenant, issue, now);
      }
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "Unknown orchestration error";
      trackerRateLimits =
        trackerRateLimits ?? extractTrackerRateLimitsFromError(error);
      rateLimits = rateLimits ?? trackerRateLimits;
    }
    trackerRateLimits =
      trackerRateLimits ??
      this.lastTrackerRateLimitsByProject.get(tenant.projectId) ??
      null;
    rateLimits = rateLimits ?? trackerRateLimits;

    const effectivePollIntervalMs = resolveAdaptivePollIntervalMs(
      pollIntervalMs,
      trackerRateLimits
    );
    if (
      effectivePollIntervalMs > pollIntervalMs &&
      isLowRateLimit(trackerRateLimits, LOW_RATE_LIMIT_WARNING_THRESHOLD)
    ) {
      const observedTrackerRateLimits = trackerRateLimits ?? {};
      const rateLimitSource =
        observedTrackerRateLimits.source === "github"
          ? "GitHub"
          : observedTrackerRateLimits.source === "linear"
            ? "Linear"
            : typeof observedTrackerRateLimits.source === "string"
              ? observedTrackerRateLimits.source
              : "tracker";
      this.writeStderr(
        `[orchestrator] low ${rateLimitSource} rate limit for ${tenant.projectId}: interval=${effectivePollIntervalMs}ms rateLimits=${JSON.stringify(
          observedTrackerRateLimits
        )}`
      );
    }
    this.projectPollIntervals.set(tenant.projectId, effectivePollIntervalMs);
    await this.store.saveProjectIssueOrchestrations(
      tenant.projectId,
      issueRecords
    );

    const allTenantRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.projectId === tenant.projectId
    );
    const issueWorkspaces = await this.store.loadIssueWorkspaces(
      tenant.projectId
    );
    const latestRuns = allTenantRuns.filter((run) =>
      isActiveRunRecordStatus(run.status)
    );
    rateLimits =
      rateLimits ??
      trackerRateLimits ??
      resolveProjectRateLimits(latestRuns, []);
    const dispatchRateLimits = trackerRateLimits ?? rateLimits;
    const status = buildProjectSnapshot({
      project: tenant,
      activeRuns: latestRuns,
      allRuns: allTenantRuns,
      summary: { dispatched, suppressed, recovered },
      lastTickAt: now.toISOString(),
      lastError,
      rateLimits,
      dispatchSuppressedUntil: resolveDispatchSuppressedUntil(
        lastError,
        dispatchRateLimits
      ),
      issueWorkspaces,
    });
    await this.store.saveProjectStatus({
      ...status,
      projectId: tenant.projectId,
    } as ProjectStatusSnapshot & { projectId: string });
    return status;
  }

  private async performStartupCleanup(
    trackerDependencies: OrchestratorTrackerDependencies = {}
  ): Promise<void> {
    const tenant = this.projectConfig;
    const now = this.now();
    const workspaceRecords = await this.store.loadIssueWorkspaces(
      tenant.projectId
    );
    if (workspaceRecords.length === 0) {
      return;
    }

    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const workflowCache = new Map<string, Promise<ProjectWorkflowResolution>>();
    let issues: TrackedIssue[];
    try {
      issues = await trackerAdapter.listIssuesByStates(
        tenant,
        await this.resolveStartupCleanupTerminalStates(
          tenant,
          workspaceRecords,
          workflowCache
        ),
        trackerDependencies
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown tracker error";
      console.warn(
        `[orchestrator] Startup cleanup skipped for project ${tenant.projectId}: ${message}`
      );
      return;
    }

    const issuesById = new Map(issues.map((issue) => [issue.id, issue]));

    for (const workspaceRecord of workspaceRecords) {
      if (workspaceRecord.status === "removed") {
        continue;
      }

      const issue = issuesById.get(workspaceRecord.issueSubjectId);
      if (!issue) {
        continue;
      }

      try {
        const resolution = await this.loadStartupCleanupWorkflow(
          tenant,
          workflowCache
        );

        if (!resolution.isValid) {
          continue;
        }
        if (!isStateTerminal(issue.state, resolution.lifecycle)) {
          continue;
        }

        await this.cleanupTerminalIssueWorkspace(
          tenant,
          issue,
          now,
          resolution
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown startup cleanup error";
        console.warn(
          `[orchestrator] Startup cleanup skipped workspace for ${issue.identifier}: ${message}`
        );
      }
    }
  }

  private async notifyTick(snapshot: ProjectStatusSnapshot): Promise<void> {
    if (!this.dependencies.onTick) {
      return;
    }

    try {
      await this.dependencies.onTick(snapshot);
    } catch (error) {
      this.writeStderr(
        `[orchestrator] onTick callback failed: ${this.formatErrorMessage(error)}`
      );
    }
  }

  private formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }

    return String(error);
  }

  private async resolveStartupCleanupTerminalStates(
    tenant: OrchestratorProjectConfig,
    _workspaceRecords: readonly IssueWorkspaceRecord[],
    workflowCache: Map<string, Promise<ProjectWorkflowResolution>>
  ): Promise<string[]> {
    const terminalStates = new Map<string, string>();

    try {
      const resolution = await this.loadStartupCleanupWorkflow(
        tenant,
        workflowCache
      );
      if (isUsableWorkflowResolution(resolution)) {
        for (const state of resolution.lifecycle.terminalStates) {
          const normalizedState = state.trim().toLowerCase();
          if (!terminalStates.has(normalizedState)) {
            terminalStates.set(normalizedState, state);
          }
        }
      }
    } catch {
      // Fall back to the default lifecycle below when startup workflow loading fails.
    }

    if (terminalStates.size === 0) {
      for (const state of DEFAULT_WORKFLOW_LIFECYCLE.terminalStates) {
        terminalStates.set(state.trim().toLowerCase(), state);
      }
    }

    return [...terminalStates.values()];
  }

  private async loadStartupCleanupWorkflow(
    tenant: OrchestratorProjectConfig,
    workflowCache: Map<string, Promise<ProjectWorkflowResolution>>
  ): Promise<ProjectWorkflowResolution> {
    const cacheKey = this.workflowCacheKey(tenant.repository);
    const cachedResolution = workflowCache.get(cacheKey);
    if (cachedResolution) {
      return cachedResolution;
    }

    const resolutionPromise = this.loadProjectWorkflow(
      tenant,
      tenant.repository
    );
    workflowCache.set(cacheKey, resolutionPromise);
    return resolutionPromise;
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.reconcilePromise;
    let release!: () => void;
    this.reconcilePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runOnceInternal(
    issueIdentifier: string | undefined,
    trackerDependencies: OrchestratorTrackerDependencies
  ): Promise<ProjectStatusSnapshot> {
    return this.runSerialized(async () => {
      const workflowResolutionCache = new Map<
        string,
        Promise<WorkflowResolution>
      >();
      this.workflowResolutionCache = workflowResolutionCache;
      try {
        return await this.reconcileProject(
          this.projectConfig,
          issueIdentifier,
          trackerDependencies
        );
      } finally {
        if (this.workflowResolutionCache === workflowResolutionCache) {
          this.workflowResolutionCache = null;
        }
      }
    });
  }

  private createTrackerDependencies(): OrchestratorTrackerDependencies {
    return {
      assignedOnly: this.dependencies.assignedOnly,
      fetchImpl: this.dependencies.fetchImpl,
      projectItemsCache: createProjectItemsCache(),
      issueCommentCache: this.resolveIssueCommentCache(
        this.projectConfig.projectId
      ),
    };
  }

  private resolveIssueCommentCache(projectId: string): IssueCommentCache {
    const cached = this.issueCommentCaches.get(projectId);
    if (cached) {
      return cached;
    }

    const commentCache = new PersistentIssueCommentCache(
      this.store.projectDir(projectId)
    );
    this.issueCommentCaches.set(projectId, commentCache);
    return commentCache;
  }

  private async resolveCandidateTrackerDependencies(
    tenant: OrchestratorProjectConfig,
    trackerDependencies: OrchestratorTrackerDependencies
  ): Promise<OrchestratorTrackerDependencies> {
    const resolution = await this.loadProjectWorkflow(
      tenant,
      tenant.repository
    );
    if (!isUsableWorkflowResolution(resolution)) {
      return trackerDependencies;
    }

    return {
      ...trackerDependencies,
      workflowLifecycle: resolution.lifecycle,
    };
  }

  private async findLatestRunForIssue(
    issueId: string,
    issueIdentifier: string
  ): Promise<OrchestratorRunRecord | null> {
    const matchingRuns = (await this.store.loadAllRuns())
      .filter((run) => run.projectId === this.projectConfig.projectId)
      .filter(
        (run) =>
          run.issueId === issueId || run.issueIdentifier === issueIdentifier
      )
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime()
      );

    return matchingRuns[0] ?? null;
  }

  private async resolveActionableCandidates(
    tenant: OrchestratorProjectConfig,
    issues: TrackedIssue[]
  ): Promise<{
    candidates: TrackedIssue[];
    lifecyclesByIssueIdentifier: Map<string, WorkflowLifecycleConfig>;
  }> {
    const candidates: TrackedIssue[] = [];
    const lifecyclesByIssueIdentifier = new Map<
      string,
      WorkflowLifecycleConfig
    >();

    for (const issue of issues) {
      const lifecycle = await this.resolveIssueLifecycle(tenant, issue);
      if (!lifecycle) {
        continue;
      }
      lifecyclesByIssueIdentifier.set(issue.identifier, lifecycle);

      if (!this.isIssueCandidateEligible(issue, lifecycle, issues)) {
        continue;
      }

      candidates.push(issue);
    }

    return {
      candidates,
      lifecyclesByIssueIdentifier,
    };
  }

  private async resolveIssueLifecycle(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue
  ): Promise<WorkflowLifecycleConfig | null> {
    const resolution = await this.loadProjectWorkflow(tenant, issue.repository);
    return isUsableWorkflowResolution(resolution) ? resolution.lifecycle : null;
  }

  private isIssueCandidateEligible(
    issue: TrackedIssue,
    lifecycle: WorkflowLifecycleConfig,
    issues: readonly TrackedIssue[]
  ): boolean {
    if (isArchivedProjectItem(issue)) {
      return false;
    }

    return isIssueCandidateEligibleWithReason(issue, lifecycle, issues)
      .eligible;
  }

  private async publishLinkedPullRequestActiveAdvisories(
    tenant: OrchestratorProjectConfig,
    trackerAdapter: OrchestratorTrackerAdapter,
    issues: readonly TrackedIssue[],
    trackerDependencies: OrchestratorTrackerDependencies
  ): Promise<void> {
    if (!trackerAdapter.upsertIssueComment) {
      return;
    }

    for (const issue of issues) {
      if (
        isArchivedProjectItem(issue) ||
        issue.metadata.contentType === "PullRequest"
      ) {
        continue;
      }

      const resolution = await this.loadProjectWorkflow(
        tenant,
        issue.repository
      );
      if (!isUsableWorkflowResolution(resolution)) {
        continue;
      }
      const lifecycle = resolution.lifecycle;

      if (isStateTerminal(issue.state, lifecycle)) {
        continue;
      }

      const linkedPullRequest = findActiveLinkedPullRequest(issue, lifecycle);
      if (!linkedPullRequest) {
        continue;
      }

      const marker = buildLinkedPullRequestActiveAdvisoryMarker(
        issue.id,
        linkedPullRequest.id
      );
      const body = buildLinkedPullRequestActiveAdvisoryBody({
        marker,
        issue,
        linkedPullRequest,
        lifecycle,
      });

      try {
        await trackerAdapter.upsertIssueComment(
          tenant,
          issue,
          { marker, body },
          trackerDependencies
        );
      } catch (error) {
        this.writeStderr(
          `[orchestrator] failed to publish linked PR active advisory for ${issue.identifier}: ${this.formatErrorMessage(error)}`
        );
      }
    }
  }

  private async loadProjectWorkflow(
    tenant: OrchestratorProjectConfig,
    repository: RepositoryRef
  ): Promise<WorkflowResolution> {
    const cacheKey = this.workflowCacheKey(repository);
    const pendingCache = this.workflowResolutionCache;
    if (pendingCache) {
      const cachedResolution = pendingCache.get(cacheKey);
      if (cachedResolution) {
        return cachedResolution;
      }

      const resolutionPromise = this.loadProjectWorkflowUncached(
        tenant,
        repository
      );
      pendingCache.set(cacheKey, resolutionPromise);
      return resolutionPromise;
    }

    return this.loadProjectWorkflowUncached(tenant, repository);
  }

  private async loadProjectWorkflowUncached(
    tenant: OrchestratorProjectConfig,
    repository: RepositoryRef
  ): Promise<WorkflowResolution> {
    const cacheRoot = join(
      this.store.projectDir(tenant.projectId),
      "cache",
      repository.owner,
      repository.name
    );
    const repositoryDirectory =
      this.resolveWorkflowRepositoryDirectory(repository);
    const resolution = await loadRepositoryWorkflow(
      repositoryDirectory,
      repository
    );
    return this.resolveWorkflowResolution(repository, cacheRoot, resolution);
  }

  private async startRun(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue,
    options: {
      recovery?: IncompleteTurnRecoveryContext | null;
      onPrepared?: (run: OrchestratorRunRecord) => Promise<void>;
    } = {}
  ): Promise<OrchestratorRunRecord> {
    if (this.shuttingDown || !this.running) {
      throw new Error(
        "Orchestrator is shutting down and cannot start new runs."
      );
    }

    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const now = this.now();
    const runId = createRunId(now, tenant.projectId, issue.identifier);
    const runDir = this.store.runDir(runId, tenant.projectId);
    const workspaceRuntimeDir = runDir;

    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const preferredWorkspaceKey = deriveIssueWorkspaceKey(
      identity,
      issue.identifier
    );
    const legacyWorkspaceKey = deriveLegacyIssueWorkspaceKey(
      identity,
      tenant.projectId
    );
    const existingWorkspaceRecord =
      (await this.store.loadIssueWorkspace(
        tenant.projectId,
        preferredWorkspaceKey
      )) ??
      (legacyWorkspaceKey === preferredWorkspaceKey
        ? null
        : await this.store.loadIssueWorkspace(
            tenant.projectId,
            legacyWorkspaceKey
          ));
    const workspaceKey =
      existingWorkspaceRecord?.workspaceKey ?? preferredWorkspaceKey;
    const projectDir = this.store.projectDir(tenant.projectId);
    const issueWorkspacePath = resolveIssueWorkspaceDirectory(
      projectDir,
      workspaceKey
    );
    const pullRequestBranch = resolvePullRequestBranchCheckoutTarget(issue);

    // #507: dirty recovery may only reuse the workspace when the dirty state
    // is attributable to this run's issue. Otherwise quarantine the workspace
    // (preserving the foreign work for operators) and start from a fresh clone.
    let recovery = options.recovery ?? null;
    let workspaceQuarantined = false;
    if (
      recovery?.kind === "incomplete-turn-dirty-workspace" &&
      existingWorkspaceRecord
    ) {
      const currentBranch = await readGitCurrentBranch(
        join(issueWorkspacePath, "repository")
      );
      const attribution = attributeDirtyWorkToIssue({
        issueIdentifier: issue.identifier,
        currentBranch,
        dirtyFiles: recovery.dirtyFiles,
        expectedBranches: pullRequestBranch
          ? [pullRequestBranch.headRefName]
          : [],
      });
      if (!attribution.attributed) {
        const quarantinePath = await quarantineIssueWorkspace(
          issueWorkspacePath,
          now
        );
        workspaceQuarantined = true;
        recovery = null;
        this.writeStderr(
          `[orchestrator] quarantined dirty workspace for ${issue.identifier}: ${attribution.reason}`
        );
        await this.store.appendRunEvent(runId, {
          at: now.toISOString(),
          event: "recovery-quarantined",
          projectId: tenant.projectId,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          workspaceKey,
          reason: attribution.reason,
          currentBranch,
          quarantinePath,
          dirtyFiles: formatRecoveryDirtyFiles(
            options.recovery?.dirtyFiles ?? []
          ),
        });
      }
    }

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository: issue.repository,
      issueWorkspacePath,
      existingWorkspace:
        Boolean(existingWorkspaceRecord) && !workspaceQuarantined,
      pullRequestBranch,
      allowDirtyExistingWorkspace:
        recovery?.kind === "incomplete-turn-dirty-workspace",
    });

    if (!existingWorkspaceRecord || workspaceQuarantined) {
      const workspaceRecord: IssueWorkspaceRecord = {
        workspaceKey,
        projectId: tenant.projectId,
        adapter: issue.tracker.adapter,
        issueSubjectId,
        issueIdentifier: issue.identifier,
        workspacePath: issueWorkspacePath,
        repositoryPath: repositoryDirectory,
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastError: null,
      };
      await this.store.saveIssueWorkspace(workspaceRecord);

      // Run after_create hook for new issue workspaces
      const afterCreateResult = await this.runHook(
        "after_create",
        tenant,
        repositoryDirectory,
        issue.repository,
        {
          projectId: tenant.projectId,
          workspaceKey,
          issueSubjectId,
          issueIdentifier: issue.identifier,
          workspacePath: issueWorkspacePath,
          repositoryPath: repositoryDirectory,
        }
      );
      if (
        afterCreateResult &&
        afterCreateResult.outcome !== "success" &&
        afterCreateResult.outcome !== "skipped"
      ) {
        await this.store.appendRunEvent(runId, {
          at: now.toISOString(),
          event: "hook-failed",
          projectId: tenant.projectId,
          hook: "after_create",
          error: afterCreateResult.error ?? null,
        } as OrchestratorEvent);
      }
    }

    const workflow = await this.loadProjectWorkflow(tenant, issue.repository);
    if (!isUsableWorkflowResolution(workflow)) {
      throw new Error(
        workflow.validationError ?? "Invalid repository WORKFLOW.md"
      );
    }
    // Render the issue prompt from the workflow template
    const promptVariables = buildPromptVariables(issue, {
      attempt: null, // first execution
    });
    const renderedPrompt = composeWorkerRunPrompt(
      issue,
      workflow.promptTemplate,
      promptVariables,
      recovery
    );

    // Run before_run hook before spawning the worker
    await this.runHook(
      "before_run",
      tenant,
      repositoryDirectory,
      issue.repository,
      {
        projectId: tenant.projectId,
        workspaceKey,
        issueSubjectId,
        issueIdentifier: issue.identifier,
        workspacePath: issueWorkspacePath,
        repositoryPath: repositoryDirectory,
        runId,
        state: issue.state,
      }
    );

    const runtimeTimeouts = resolveWorkflowRuntimeTimeouts(workflow.workflow);
    const buildRunRecord = (
      processId: number | null
    ): OrchestratorRunRecord => ({
      runId,
      projectId: tenant.projectId,
      projectSlug: tenant.slug,
      issueId: issue.id,
      issueSubjectId,
      trackerItemId: issue.tracker.itemId,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueState: issue.state,
      repository: issue.repository,
      status: "running",
      attempt: 1,
      processId,
      port: null,
      workingDirectory: repositoryDirectory,
      issueWorkspaceKey: workspaceKey,
      workspaceRuntimeDir,
      workflowPath: workflow.workflowPath,
      retryKind: recovery ? "recovery" : null,
      threadId: null,
      cumulativeTurnCount: 0,
      lastTurnSummary: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      runPhase: "preparing_workspace",
      rateLimits: issue.rateLimits ?? null,
      recovery,
    });

    // Fence the issue to this run before the worker can request its first
    // lease. This also leaves a recoverable preparing record if the daemon
    // exits between preparation and process spawn.
    await options.onPrepared?.(buildRunRecord(null));
    mkdirSync(runDir, { recursive: true });
    const workerLogStream = (
      this.dependencies.createWriteStreamImpl ?? createWriteStream
    )(join(runDir, "worker.log"), {
      flags: "a",
    });
    let workerLogAvailable = true;
    let workerExited = false;
    let workerStderrFinalizing = false;
    let workerLogBackpressured = false;
    const resumeWorkerStderr = () => {
      if (!workerLogBackpressured) {
        return;
      }
      workerLogBackpressured = false;
      child.stderr?.resume?.();
    };
    const markWorkerLogUnavailable = (error: unknown) => {
      resumeWorkerStderr();
      if (!workerLogAvailable) {
        return;
      }
      workerLogAvailable = false;
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown");
      this.writeStderr(
        `[orchestrator] failed to write worker log for ${runId}: ${message}`
      );
    };
    const child = (this.dependencies.spawnImpl ?? spawn)(
      "bash",
      ["-lc", resolveWorkerCommand()],
      {
        cwd: process.cwd(),
        env: this.buildProjectExecutionEnv(tenant.projectId, {
          CODEX_PROJECT_ID: tenant.projectId,
          PROJECT_ID: tenant.projectId,
          WORKING_DIRECTORY: repositoryDirectory,
          WORKSPACE_RUNTIME_DIR: workspaceRuntimeDir,
          SYMPHONY_RUN_ID: runId,
          SYMPHONY_ISSUE_STATE: issue.state,
          SYMPHONY_ISSUE_ID: issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
          SYMPHONY_ISSUE_TITLE: issue.title,
          SYMPHONY_ISSUE_SUBJECT_ID: issueSubjectId,
          SYMPHONY_ISSUE_WORKSPACE_KEY: workspaceKey,
          SYMPHONY_TRACKER_ADAPTER: issue.tracker.adapter,
          SYMPHONY_TRACKER_BINDING_ID: issue.tracker.bindingId,
          SYMPHONY_TRACKER_ITEM_ID: issue.tracker.itemId,
          TARGET_REPOSITORY_CLONE_URL: issue.repository.cloneUrl,
          TARGET_REPOSITORY_OWNER: issue.repository.owner,
          TARGET_REPOSITORY_NAME: issue.repository.name,
          TARGET_REPOSITORY_URL: issue.repository.url,
          ...trackerAdapter.buildWorkerEnvironment(tenant, issue),
          SYMPHONY_RENDERED_PROMPT: renderedPrompt,
          SYMPHONY_WORKFLOW_PATH: workflow.workflowPath ?? "",
          SYMPHONY_AGENT_COMMAND: resolveWorkflowRuntimeCommand(
            workflow.workflow
          ),
          SYMPHONY_APPROVAL_POLICY:
            workflow.workflow.codex.approvalPolicy ?? "",
          SYMPHONY_THREAD_SANDBOX: workflow.workflow.codex.threadSandbox ?? "",
          SYMPHONY_TURN_SANDBOX_POLICY:
            workflow.workflow.codex.turnSandboxPolicy ?? "",
          SYMPHONY_MAX_TURNS: String(workflow.workflow.agent.maxTurns),
          SYMPHONY_ORCHESTRATOR_URL: this.workerOrchestratorUrl ?? "",
          SYMPHONY_ORCHESTRATOR_TOKEN: this.workerOrchestratorToken ?? "",
          SYMPHONY_MAX_NONPRODUCTIVE_TURNS:
            process.env.SYMPHONY_MAX_NONPRODUCTIVE_TURNS ??
            String(DEFAULT_MAX_NONPRODUCTIVE_TURNS),
          // Clear legacy resume/budget env so fresh worker sessions do not
          // inherit stale process-level values.
          SYMPHONY_GLOBAL_MAX_TURNS: "",
          SYMPHONY_MAX_TOKENS: "",
          SYMPHONY_SESSION_TIMEOUT_MS: "",
          SYMPHONY_RESUME_THREAD_ID: "",
          SYMPHONY_CUMULATIVE_TURN_COUNT: "0",
          SYMPHONY_CUMULATIVE_INPUT_TOKENS: "0",
          SYMPHONY_CUMULATIVE_OUTPUT_TOKENS: "0",
          SYMPHONY_CUMULATIVE_TOTAL_TOKENS: "0",
          SYMPHONY_LAST_TURN_SUMMARY: "",
          SYMPHONY_RECOVERY_KIND: recovery?.kind ?? "",
          SYMPHONY_RECOVERY_DIRTY_FILES: recovery
            ? formatRecoveryDirtyFilesForContext(recovery.dirtyFiles)
            : "",
          SYMPHONY_RECOVERY_SUGGESTED_COMMAND: recovery?.suggestedCommand ?? "",
          SYMPHONY_SESSION_STARTED_AT: "",
          SYMPHONY_READ_TIMEOUT_MS: String(runtimeTimeouts.readTimeoutMs),
          SYMPHONY_TURN_TIMEOUT_MS: String(runtimeTimeouts.turnTimeoutMs),
        }),
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    const handleWorkerStderrChunk = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      if (workerLogAvailable) {
        try {
          if (!workerLogStream.write(buffer)) {
            workerLogBackpressured = true;
            child.stderr?.pause?.();
          }
        } catch (error) {
          markWorkerLogUnavailable(error);
        }
      }
      this.consumeWorkerStderrChunk(runId, buffer);
    };
    const drainWorkerStderr = () => {
      const stderr = child.stderr;
      if (!stderr || typeof stderr.read !== "function") {
        return;
      }
      let chunk: Buffer | string | null;
      while ((chunk = stderr.read()) !== null) {
        handleWorkerStderrChunk(chunk);
      }
    };
    const completeWorkerStderrFinalization = (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => {
      if (workerExited) {
        return;
      }
      workerExited = true;
      workerStderrFinalizing = false;
      child.stderr?.removeListener("data", handleWorkerStderrChunk);
      this.flushWorkerStderrBuffer(runId);
      workerLogStream.end();
      if (child.pid) {
        this.retireWorkerPid(child.pid);
      }
      this.logVerbose(
        `[worker-exited] ${runId} (code=${code ?? "null"}, signal=${signal ?? "null"})`
      );
    };
    const finalizeWorkerStderr = (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => {
      if (workerExited || workerStderrFinalizing) {
        return;
      }
      workerStderrFinalizing = true;
      const stderr = child.stderr;
      const finish = () => {
        stderr?.removeListener("end", finish);
        stderr?.removeListener("close", finish);
        drainWorkerStderr();
        completeWorkerStderrFinalization(code, signal);
      };

      resumeWorkerStderr();
      drainWorkerStderr();
      if (!stderr) {
        completeWorkerStderrFinalization(code, signal);
        return;
      }

      if (
        (stderr as { readableEnded?: boolean }).readableEnded ||
        (stderr as { readable?: boolean }).readable === false
      ) {
        finish();
        return;
      }

      stderr.once("end", finish);
      stderr.once("close", finish);
    };

    workerLogStream.on("error", (error) => {
      markWorkerLogUnavailable(error);
    });
    workerLogStream.on("drain", () => {
      resumeWorkerStderr();
    });
    child.stderr?.on("data", handleWorkerStderrChunk);

    if (child.pid) {
      this.activeWorkerPids.add(child.pid);
      this.logVerbose(`[worker-started] ${runId} (pid=${child.pid})`);
    }
    child.on?.("error", (error) => {
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown");
      this.writeStderr(
        `[orchestrator] worker process error for ${runId}: ${message}`
      );
      finalizeWorkerStderr(null, null);
    });
    child.on?.("close", (code, signal) => {
      finalizeWorkerStderr(code, signal);
    });
    child.unref();

    return buildRunRecord(child.pid ?? null);
  }

  private async reconcileRun(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord,
    issueRecords: IssueOrchestrationRecord[],
    trackerDependencies: OrchestratorTrackerDependencies = {}
  ): Promise<{
    issueRecords: IssueOrchestrationRecord[];
    recovered: boolean;
  }> {
    const now = this.now();
    const issueRecord = issueRecords.find(
      (candidate) => candidate.issueId === run.issueId
    );

    if (issueRecord?.currentRunId && issueRecord.currentRunId !== run.runId) {
      if (run.processId && this.isProcessRunning(run.processId)) {
        this.sendSignal(run.processId, "SIGTERM");
        this.retireWorkerPid(run.processId);
      }
      const supersededRun: OrchestratorRunRecord = {
        ...run,
        status: "failed",
        processId: null,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        nextRetryAt: null,
        retryKind: null,
        lastError: `worker_lease_lost: run_not_current; superseded by current run ${issueRecord.currentRunId}.`,
      };
      await this.store.saveRun(supersededRun);
      await this.store.appendRunEvent(run.runId, {
        at: now.toISOString(),
        event: "run-suppressed",
        projectId: run.projectId,
        issueIdentifier: run.issueIdentifier,
        issueId: run.issueId,
        reason: "run_not_current",
      } as OrchestratorEvent);
      return { issueRecords, recovered: false };
    }

    if (run.processId && this.isProcessRunning(run.processId)) {
      const retryPolicy = await this.loadRetryPolicy(tenant, run.repository);
      const configuredStallTimeoutMs = retryPolicy?.stallTimeoutMs ?? null;
      const lastActivityAtMs = parseTimestampMs(
        run.lastEventAt ?? run.startedAt
      );
      const startedAtMs = parseTimestampMs(run.startedAt);
      const elapsedSinceLastActivityMs =
        lastActivityAtMs === null ? null : now.getTime() - lastActivityAtMs;
      const runningSinceMs =
        startedAtMs === null ? null : now.getTime() - startedAtMs;
      const isStalledByWorkflowTimeout =
        configuredStallTimeoutMs !== null &&
        configuredStallTimeoutMs > 0 &&
        elapsedSinceLastActivityMs !== null &&
        elapsedSinceLastActivityMs > configuredStallTimeoutMs;
      const isStalledByFallbackTimeout =
        runningSinceMs !== null && runningSinceMs > STUCK_WORKER_TIMEOUT_MS;

      if (isStalledByWorkflowTimeout || isStalledByFallbackTimeout) {
        const elapsedMs = isStalledByWorkflowTimeout
          ? elapsedSinceLastActivityMs
          : runningSinceMs;
        const timeoutMs = isStalledByWorkflowTimeout
          ? configuredStallTimeoutMs
          : STUCK_WORKER_TIMEOUT_MS;
        const elapsedSeconds = Math.round((elapsedMs ?? 0) / 1000);
        const timeoutSeconds = Math.round((timeoutMs ?? 0) / 1000);
        if (this.isVerboseLoggingEnabled()) {
          this.writeStderr(
            `[stall-detected] ${run.runId} (elapsed=${elapsedSeconds}s > ${timeoutSeconds}s)`
          );
        } else {
          this.writeStderr(
            `[orchestrator] stuck worker detected for ${run.runId} (elapsed ${elapsedSeconds}s > ${timeoutSeconds}s) — sending SIGTERM`
          );
        }
        this.sendSignal(run.processId, "SIGTERM");
        // Fall through: treat as a normal exit and retry.
      } else {
        const runningRecord: OrchestratorRunRecord = {
          ...run,
          status: "running",
          updatedAt: now.toISOString(),
        };
        await this.store.saveRun(runningRecord);
        issueRecords = upsertIssueOrchestration(issueRecords, {
          issueId: run.issueId,
          identifier: run.issueIdentifier,
          workspaceKey:
            run.issueWorkspaceKey ??
            deriveIssueWorkspaceKey(
              {
                adapter: tenant.tracker.adapter,
                issueSubjectId: run.issueSubjectId,
              },
              run.issueIdentifier
            ),
          state: "running",
          currentRunId: run.runId,
          retryEntry: null,
          updatedAt: now.toISOString(),
        });
        return {
          issueRecords,
          recovered: false,
        };
      }
    }
    if (run.processId) {
      this.retireWorkerPid(run.processId);
    }

    const workerInfo = await this.fetchWorkerRunInfo(run);
    const runWithTokens: OrchestratorRunRecord = {
      ...run,
      runtimeSession: buildRuntimeSession(
        run.runtimeSession,
        workerInfo.sessionId,
        workerInfo.threadId,
        run.status === "running"
          ? "failed"
          : (run.runtimeSession?.status ?? null),
        run.runtimeSession?.startedAt ?? run.startedAt ?? now.toISOString(),
        now.toISOString(),
        workerInfo.exitClassification
      ),
      threadId: workerInfo.threadId ?? run.threadId ?? null,
      cumulativeTurnCount: resolveCumulativeTurnCount(
        run,
        workerInfo.turnCount ?? null
      ),
      tokenUsage: workerInfo.tokenUsage ?? run.tokenUsage,
      lastEvent: workerInfo.lastEvent ?? run.lastEvent,
      lastTurnSummary: resolveLastTurnSummary(
        run.lastTurnSummary,
        resolveLastTurnSummaryCandidate(
          workerInfo.lastEvent,
          workerInfo.lastError
        )
      ),
      lastEventAt: workerInfo.lastEventAt ?? run.lastEventAt ?? undefined,
      lastEventAtSource:
        workerInfo.lastEventAtSource ?? run.lastEventAtSource ?? undefined,
      executionPhase: workerInfo.executionPhase ?? run.executionPhase ?? null,
      runPhase: workerInfo.runPhase ?? run.runPhase ?? null,
      rateLimits: workerInfo.rateLimits ?? run.rateLimits ?? null,
    };
    const workerSessionId = workerInfo.sessionId;

    if (workerInfo.lastError) {
      await this.store.appendRunEvent(run.runId, {
        at: now.toISOString(),
        event: "worker-error",
        projectId: run.projectId,
        runId: run.runId,
        issueIdentifier: run.issueIdentifier,
        error: workerInfo.lastError,
        attempt: run.attempt,
      } as OrchestratorEvent);
    }

    if (run.status === "retrying" && run.nextRetryAt) {
      if (new Date(run.nextRetryAt).getTime() > now.getTime()) {
        return {
          issueRecords,
          recovered: false,
        };
      }

      if (
        (await this.resolveRetryRestartAction(
          tenant,
          run,
          trackerDependencies
        )) === "release"
      ) {
        return this.releaseRetryingRun(runWithTokens, issueRecords, now);
      }

      return this.restartRun(tenant, run, issueRecords, now, workerSessionId);
    }

    if (run.issueWorkspaceKey) {
      const issueWorkspacePath = resolveIssueWorkspaceDirectory(
        this.store.projectDir(tenant.projectId),
        run.issueWorkspaceKey
      );

      await this.runHook(
        "after_run",
        tenant,
        run.workingDirectory,
        run.repository,
        {
          projectId: run.projectId,
          workspaceKey: run.issueWorkspaceKey,
          issueSubjectId: run.issueSubjectId,
          issueIdentifier: run.issueIdentifier,
          workspacePath: issueWorkspacePath,
          repositoryPath: run.workingDirectory,
          runId: run.runId,
          state: run.issueState,
        }
      );
    }

    const recovery = await this.classifyIncompleteTurnDirtyWorkspace(
      tenant,
      runWithTokens,
      now
    );
    const convergenceDetected =
      workerInfo.exitClassification === "convergence-detected";

    if (convergenceDetected && !recovery) {
      const trackerRecovery = await this.returnConvergedIssueToRetryableState(
        tenant,
        runWithTokens,
        trackerDependencies
      );
      if (trackerRecovery.confirmed) {
        const completedRun: OrchestratorRunRecord = {
          ...runWithTokens,
          issueState: trackerRecovery.state ?? runWithTokens.issueState,
          status: "failed",
          processId: null,
          updatedAt: now.toISOString(),
          completedAt: now.toISOString(),
          nextRetryAt: null,
          retryKind: null,
          lastError: runWithTokens.lastError,
          runPhase: runWithTokens.runPhase ?? "failed",
        };
        await this.store.saveRun(completedRun);
        this.logVerbose(
          `[run-completed] ${completedRun.runId} status=${completedRun.status}`
        );
        return {
          issueRecords: releaseIssueOrchestration(
            issueRecords,
            run.issueId,
            now
          ),
          recovered: false,
        };
      }
    }

    // Determine retry kind: continuation (issue still actionable) vs failure
    const retryKind = convergenceDetected
      ? "failure"
      : await this.classifyRetryKind(tenant, run, trackerDependencies);
    const persistedRetryKind = recovery ? "recovery" : retryKind;

    const failureRetryCount =
      retryKind === "failure" && !recovery
        ? (this.resolveFailureRetryCount(issueRecords, run.issueId) ?? 0) + 1
        : (this.resolveFailureRetryCount(issueRecords, run.issueId) ?? 0);
    const maxFailureRetries = await this.loadMaxFailureRetries(
      tenant,
      run.repository
    );
    if (
      retryKind === "failure" &&
      !recovery &&
      failureRetryCount >= maxFailureRetries
    ) {
      const lastError = [
        `Run suppressed: ${MAX_FAILURE_RETRIES_EXCEEDED_REASON}.`,
        `failureRetryCount=${failureRetryCount}.`,
        `maxFailureRetries=${maxFailureRetries}.`,
      ].join(" ");
      const suppressedRun: OrchestratorRunRecord = {
        ...runWithTokens,
        status: "suppressed",
        processId: null,
        updatedAt: now.toISOString(),
        completedAt: now.toISOString(),
        nextRetryAt: null,
        retryKind: null,
        runPhase: runWithTokens.runPhase ?? "failed",
        lastError,
      };
      await this.store.saveRun(suppressedRun);
      await this.store.appendRunEvent(run.runId, {
        at: now.toISOString(),
        event: "run-suppressed",
        projectId: run.projectId,
        issueIdentifier: run.issueIdentifier,
        issueId: run.issueId,
        reason: MAX_FAILURE_RETRIES_EXCEEDED_REASON,
      } as OrchestratorEvent);
      this.logVerbose(
        `[run-completed] ${suppressedRun.runId} status=${suppressedRun.status}`
      );
      return {
        issueRecords: upsertIssueOrchestration(issueRecords, {
          issueId: run.issueId,
          identifier: run.issueIdentifier,
          workspaceKey:
            run.issueWorkspaceKey ??
            deriveIssueWorkspaceKey(
              {
                adapter: tenant.tracker.adapter,
                issueSubjectId: run.issueSubjectId,
              },
              run.issueIdentifier
            ),
          state: "released",
          failureRetryCount,
          currentRunId: null,
          retryEntry: null,
          updatedAt: now.toISOString(),
        }),
        recovered: false,
      };
    }

    let nextRetryAt: string;
    if (recovery || retryKind === "continuation") {
      nextRetryAt = new Date(
        now.getTime() + CONTINUATION_RETRY_DELAY_MS
      ).toISOString();
    } else {
      const retryOptions = await this.loadRetryPolicy(tenant, run.repository);
      // Exponential backoff for failure retries
      const backoffMs =
        this.dependencies.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
      nextRetryAt = (
        retryOptions
          ? scheduleRetryAt(now, run.attempt + 1, retryOptions)
          : new Date(now.getTime() + backoffMs)
      ).toISOString();
    }

    const retryRecord: OrchestratorRunRecord = {
      ...runWithTokens,
      status: "retrying",
      attempt: runWithTokens.attempt + 1,
      processId: null,
      updatedAt: now.toISOString(),
      nextRetryAt,
      retryKind: persistedRetryKind,
      threadId:
        runWithTokens.threadId ??
        runWithTokens.runtimeSession?.threadId ??
        run.threadId ??
        run.runtimeSession?.threadId ??
        null,
      cumulativeTurnCount:
        runWithTokens.cumulativeTurnCount ?? run.cumulativeTurnCount ?? 0,
      lastTurnSummary:
        runWithTokens.lastTurnSummary ?? run.lastTurnSummary ?? null,
      runPhase: runWithTokens.runPhase ?? "failed",
      lastError: convergenceDetected
        ? (runWithTokens.lastError ??
          "convergence_detected: repeated non-productive turns")
        : recovery || retryKind === "continuation"
          ? null
          : "Worker process exited unexpectedly.",
      recovery,
    };
    await this.store.saveRun(retryRecord);
    this.logVerbose(
      `[retry-scheduled] ${retryRecord.runId} kind=${persistedRetryKind} attempt=${retryRecord.attempt} nextAt=${nextRetryAt}`
    );
    this.logVerbose(
      `[run-completed] ${retryRecord.runId} status=${retryRecord.status}`
    );
    issueRecords = upsertIssueOrchestration(issueRecords, {
      issueId: run.issueId,
      identifier: run.issueIdentifier,
      workspaceKey:
        run.issueWorkspaceKey ??
        deriveIssueWorkspaceKey(
          {
            adapter: tenant.tracker.adapter,
            issueSubjectId: run.issueSubjectId,
          },
          run.issueIdentifier
        ),
      state: "retry_queued",
      completedOnce: retryKind === "continuation" ? true : undefined,
      failureRetryCount,
      currentRunId: run.runId,
      retryEntry: {
        attempt: retryRecord.attempt,
        dueAt: nextRetryAt,
        error: retryRecord.lastError,
      },
      updatedAt: now.toISOString(),
    });
    return {
      issueRecords,
      recovered: false,
    };
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private isVerboseLoggingEnabled(): boolean {
    return this.dependencies.logLevel === "verbose";
  }

  private writeStderr(message: string): void {
    (this.dependencies.stderr ?? process.stderr).write(`${message}\n`);
  }

  private consumeWorkerStderrChunk(runId: string, chunk: Buffer): void {
    let decoder = this.workerStderrDecoders.get(runId);
    if (!decoder) {
      decoder = new StringDecoder("utf8");
      this.workerStderrDecoders.set(runId, decoder);
    }
    const nextBuffer =
      (this.workerStderrBuffers.get(runId) ?? "") + decoder.write(chunk);
    const lines = nextBuffer.split("\n");
    this.workerStderrBuffers.set(runId, lines.pop() ?? "");

    for (const line of lines) {
      this.consumeWorkerStderrLine(runId, line);
    }
  }

  private flushWorkerStderrBuffer(runId: string): void {
    const decoder = this.workerStderrDecoders.get(runId);
    const remainder =
      (this.workerStderrBuffers.get(runId) ?? "") + (decoder?.end() ?? "");
    this.workerStderrBuffers.delete(runId);
    this.workerStderrDecoders.delete(runId);
    if (remainder && remainder.trim()) {
      this.consumeWorkerStderrLine(runId, remainder);
    }
  }

  private consumeWorkerStderrLine(runId: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isOrchestratorChannelEvent(parsed)) {
        return;
      }

      void this.runSerialized(() =>
        this.applyWorkerChannelEvent(runId, parsed)
      ).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "unknown");
        this.writeStderr(
          `[orchestrator] failed to apply worker channel event for ${runId}: ${message}`
        );
      });
    } catch {
      // Ignore non-JSON stderr lines; they remain in worker.log for observability.
    }
  }

  private async applyWorkerChannelEvent(
    runId: string,
    event: OrchestratorChannelEvent
  ): Promise<void> {
    const run = await this.store.loadRun(runId, this.projectConfig.projectId);
    if (
      !run ||
      !canApplyWorkerChannelUpdate(run.status) ||
      run.issueId !== event.issueId
    ) {
      return;
    }

    if (event.type === "heartbeat") {
      const nowIso = this.now().toISOString();
      const persistedLastEventAt = event.lastEventAt ?? run.lastEventAt ?? null;

      await this.store.saveRun({
        ...run,
        updatedAt: nowIso,
        lastEvent: "heartbeat",
        lastTurnSummary: resolveLastTurnSummary(
          run.lastTurnSummary,
          event.lastError
        ),
        lastEventAt: persistedLastEventAt,
        lastEventAtSource:
          event.lastEventAt != null
            ? "event-channel"
            : (run.lastEventAtSource ?? null),
        tokenUsage: event.tokenUsage,
        rateLimits: event.rateLimits,
        runtimeSession: buildRuntimeSession(
          run.runtimeSession,
          resolveChannelSessionId(event.sessionInfo),
          event.sessionInfo?.threadId ?? null,
          "active",
          run.startedAt ?? run.runtimeSession?.startedAt ?? nowIso,
          nowIso,
          event.sessionInfo?.exitClassification ?? null
        ),
        threadId:
          event.sessionInfo?.threadId ??
          run.threadId ??
          run.runtimeSession?.threadId ??
          null,
        turnCount:
          event.sessionInfo && event.sessionInfo.turnCount != null
            ? event.sessionInfo.turnCount
            : run.turnCount,
        cumulativeTurnCount: resolveCumulativeTurnCount(
          run,
          event.sessionInfo?.turnCount ?? null
        ),
        executionPhase: event.executionPhase ?? run.executionPhase,
        runPhase: event.runPhase ?? run.runPhase,
        lastError: event.lastError,
      });
      return;
    }

    if (event.type === "turn_started") {
      await this.store.appendRunEvent(runId, {
        at: event.startedAt,
        event: "turn_started",
        projectId: run.projectId,
        issueIdentifier: run.issueIdentifier,
        issueId: run.issueId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        turnId: event.turnId,
        turnCount: event.turnCount,
      });
      return;
    }

    if (event.type === "turn_completed") {
      await this.store.appendRunEvent(runId, {
        at: event.completedAt,
        event: "turn_completed",
        projectId: run.projectId,
        issueIdentifier: run.issueIdentifier,
        issueId: run.issueId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        turnId: event.turnId,
        turnCount: event.turnCount,
        startedAt: event.startedAt,
        durationMs: event.durationMs,
        tokenUsage: event.tokenUsage,
      });
      return;
    }

    if (event.type === "turn_failed") {
      await this.store.appendRunEvent(runId, {
        at: event.failedAt,
        event: "turn_failed",
        projectId: run.projectId,
        issueIdentifier: run.issueIdentifier,
        issueId: run.issueId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        turnId: event.turnId,
        turnCount: event.turnCount,
        startedAt: event.startedAt,
        durationMs: event.durationMs,
        tokenUsage: event.tokenUsage,
        error: event.error,
      });
      return;
    }

    const nowIso = this.now().toISOString();
    await this.store.saveRun({
      ...run,
      updatedAt: nowIso,
      lastEvent: event.event ?? run.lastEvent ?? null,
      lastTurnSummary: resolveLastTurnSummary(
        run.lastTurnSummary,
        resolveLastTurnSummaryCandidate(event.event, event.lastError)
      ),
      lastEventAt: event.lastEventAt,
      lastEventAtSource: "event-channel",
      tokenUsage: event.tokenUsage ?? run.tokenUsage,
      rateLimits: event.rateLimits ?? run.rateLimits ?? null,
      runtimeSession: buildRuntimeSession(
        run.runtimeSession,
        resolveChannelSessionId(event.sessionInfo),
        event.sessionInfo?.threadId ?? run.runtimeSession?.threadId ?? null,
        "active",
        run.startedAt ?? run.runtimeSession?.startedAt ?? nowIso,
        nowIso,
        event.sessionInfo?.exitClassification ?? null
      ),
      threadId:
        event.sessionInfo?.threadId ??
        run.threadId ??
        run.runtimeSession?.threadId ??
        null,
      turnCount:
        event.sessionInfo && event.sessionInfo.turnCount != null
          ? event.sessionInfo.turnCount
          : run.turnCount,
      cumulativeTurnCount: resolveCumulativeTurnCount(
        run,
        event.sessionInfo?.turnCount ?? null
      ),
      executionPhase: event.executionPhase ?? run.executionPhase ?? null,
      runPhase: event.runPhase ?? run.runPhase ?? null,
      lastError: event.lastError ?? run.lastError,
    });
  }

  private logVerbose(message: string): void {
    if (!this.isVerboseLoggingEnabled()) {
      return;
    }
    this.writeStderr(message);
  }

  private async waitForNextPoll(): Promise<void> {
    if (this.consumePendingReconcileRequest()) {
      return;
    }

    const customWait = this.dependencies.waitImpl;
    const pollIntervalMs = this.getEffectivePollIntervalMs();
    const waitPromise = this.createPendingSleepPromise();

    try {
      if (customWait) {
        await Promise.race([customWait(pollIntervalMs), waitPromise]);
      } else {
        this.sleepTimer = setTimeout(() => {
          this.sleepResolver?.();
        }, pollIntervalMs);
        await waitPromise;
      }
    } finally {
      this.cancelPendingSleep();
    }

    this.consumePendingReconcileRequest();
  }

  private cancelPendingSleep(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver?.();
    this.sleepResolver = null;
  }

  private createPendingSleepPromise(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepResolver = () => {
        this.sleepResolver = null;
        this.sleepTimer = null;
        resolve();
      };
    });
  }

  private consumePendingReconcileRequest(): boolean {
    if (!this.reconcileRequested) {
      return false;
    }

    this.reconcileRequested = false;
    return true;
  }

  /**
   * Classify whether a process exit should be treated as continuation retry
   * or failure retry. Continuation applies when the issue is still actionable
   * — the worker completed its session and the issue hasn't transitioned away.
   * Failure applies when we cannot confirm the issue is still actionable.
   */
  private async classifyRetryKind(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord,
    trackerDependencies: OrchestratorTrackerDependencies = {}
  ): Promise<"continuation" | "failure"> {
    try {
      const eligibleContext = await this.fetchTrackedIssueEligibilityContext(
        tenant,
        run.issueIdentifier,
        trackerDependencies
      );
      if (!eligibleContext) {
        return "failure";
      }
      const resolution = await this.loadProjectWorkflow(tenant, run.repository);
      if (!isUsableWorkflowResolution(resolution)) {
        return "failure";
      }
      return this.isIssueCandidateEligible(
        eligibleContext.issue,
        resolution.lifecycle,
        eligibleContext.issues
      )
        ? "continuation"
        : "failure";
    } catch {
      return "failure";
    }
  }

  private async resolveRetryRestartAction(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord,
    trackerDependencies: OrchestratorTrackerDependencies = {}
  ): Promise<"restart" | "release"> {
    try {
      const eligibleContext = await this.fetchTrackedIssueEligibilityContext(
        tenant,
        run.issueIdentifier,
        trackerDependencies
      );
      if (!eligibleContext) {
        return "release";
      }
      const resolution = await this.loadProjectWorkflow(tenant, run.repository);
      if (!isUsableWorkflowResolution(resolution)) {
        return "restart";
      }
      return this.isIssueCandidateEligible(
        eligibleContext.issue,
        resolution.lifecycle,
        eligibleContext.issues
      )
        ? "restart"
        : "release";
    } catch {
      return "restart";
    }
  }

  private async fetchTrackedIssueEligibilityContext(
    tenant: OrchestratorProjectConfig,
    issueIdentifier: string,
    trackerDependencies: OrchestratorTrackerDependencies = {}
  ): Promise<{ issue: TrackedIssue; issues: TrackedIssue[] } | null> {
    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const issues = await trackerAdapter.listIssues(tenant, {
      fetchImpl: this.dependencies.fetchImpl,
      ...trackerDependencies,
    });
    const issue = issues.find(
      (candidate) => candidate.identifier === issueIdentifier
    );
    return issue ? { issue, issues } : null;
  }

  private async classifyIncompleteTurnDirtyWorkspace(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord,
    now: Date
  ): Promise<IncompleteTurnRecoveryContext | null> {
    if (run.lastEvent === "turn_completed") {
      return null;
    }

    const workspaceKey =
      run.issueWorkspaceKey ??
      deriveIssueWorkspaceKey(
        {
          adapter: tenant.tracker.adapter,
          issueSubjectId: run.issueSubjectId,
        },
        run.issueIdentifier
      );
    const issueWorkspacePath = resolveIssueWorkspaceDirectory(
      this.store.projectDir(tenant.projectId),
      workspaceKey
    );
    const dirtyStatus = await inspectIssueWorkspaceDirtyStatus({
      issueWorkspacePath,
    });

    if (!dirtyStatus?.dirty) {
      return null;
    }

    return {
      kind: "incomplete-turn-dirty-workspace",
      runId: run.runId,
      issueId: run.issueId,
      issueIdentifier: run.issueIdentifier,
      workspacePath: dirtyStatus.repositoryDirectory,
      dirtyFiles: dirtyStatus.dirtyFiles,
      lastEvent: run.lastEvent ?? null,
      lastEventAt: run.lastEventAt ?? null,
      sessionId: run.runtimeSession?.sessionId ?? null,
      threadId: run.threadId ?? run.runtimeSession?.threadId ?? null,
      suggestedCommand: `cd ${shellQuote(dirtyStatus.repositoryDirectory)} && git status --short && git diff`,
      detectedAt: now.toISOString(),
    };
  }

  private async resolveIncompleteTurnRecoveryContext(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue,
    latestRun: OrchestratorRunRecord | null,
    preferredWorkspaceKey: string
  ): Promise<IncompleteTurnRecoveryContext | null> {
    const recovery = latestRun?.recovery;
    if (
      latestRun?.status !== "suppressed" ||
      recovery?.kind !== "incomplete-turn-dirty-workspace" ||
      latestRun.runtimeSession?.exitClassification !==
        "incomplete-turn-dirty-workspace"
    ) {
      return null;
    }

    const workspaceKey = latestRun.issueWorkspaceKey ?? preferredWorkspaceKey;
    const dirtyStatus = await inspectIssueWorkspaceDirtyStatus({
      issueWorkspacePath: resolveIssueWorkspaceDirectory(
        this.store.projectDir(tenant.projectId),
        workspaceKey
      ),
    });

    if (!dirtyStatus?.dirty) {
      return null;
    }

    return {
      ...recovery,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      workspacePath: dirtyStatus.repositoryDirectory,
      dirtyFiles: dirtyStatus.dirtyFiles,
      suggestedCommand: `cd ${shellQuote(dirtyStatus.repositoryDirectory)} && git status --short && git diff`,
    };
  }

  private async resolveRetryRunRecoveryContext(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord
  ): Promise<IncompleteTurnRecoveryContext | null> {
    const recovery = run.recovery;
    if (recovery?.kind !== "incomplete-turn-dirty-workspace") {
      return null;
    }

    const workspaceKey =
      run.issueWorkspaceKey ??
      deriveIssueWorkspaceKey(
        {
          adapter: tenant.tracker.adapter,
          issueSubjectId: run.issueSubjectId,
        },
        run.issueIdentifier
      );
    const dirtyStatus = await inspectIssueWorkspaceDirtyStatus({
      issueWorkspacePath: resolveIssueWorkspaceDirectory(
        this.store.projectDir(tenant.projectId),
        workspaceKey
      ),
    });

    if (!dirtyStatus?.dirty) {
      return null;
    }

    return {
      ...recovery,
      workspacePath: dirtyStatus.repositoryDirectory,
      dirtyFiles: dirtyStatus.dirtyFiles,
      suggestedCommand: `cd ${shellQuote(dirtyStatus.repositoryDirectory)} && git status --short && git diff`,
    };
  }

  private async fetchWorkerRunInfo(run: OrchestratorRunRecord): Promise<{
    tokenUsage: OrchestratorRunRecord["tokenUsage"] | null;
    sessionId: string | null;
    threadId: string | null;
    turnCount: number | null;
    exitClassification: SessionExitClassification | null;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
    lastEventAtSource: OrchestratorRunRecord["lastEventAtSource"];
    executionPhase: OrchestratorRunRecord["executionPhase"];
    runPhase: OrchestratorRunRecord["runPhase"];
    rateLimits: Record<string, unknown> | null;
  }> {
    const latestRun =
      (await this.store.loadRun(run.runId, run.projectId)) ?? run;
    const persistedTokenUsage =
      await this.readPersistedWorkerTokenUsage(latestRun);
    return {
      tokenUsage: persistedTokenUsage,
      sessionId: latestRun.runtimeSession?.sessionId ?? null,
      threadId:
        latestRun.threadId ?? latestRun.runtimeSession?.threadId ?? null,
      turnCount: latestRun.turnCount ?? null,
      exitClassification: latestRun.runtimeSession?.exitClassification ?? null,
      lastError: latestRun.lastError ?? null,
      lastEvent: latestRun.lastEvent ?? null,
      lastEventAt: latestRun.lastEventAt ?? null,
      lastEventAtSource: latestRun.lastEventAtSource ?? null,
      executionPhase: latestRun.executionPhase ?? null,
      runPhase: latestRun.runPhase ?? null,
      rateLimits: latestRun.rateLimits ?? null,
    };
  }

  private async readPersistedWorkerTokenUsage(
    run: OrchestratorRunRecord
  ): Promise<OrchestratorRunRecord["tokenUsage"] | null> {
    const artifactPaths = [
      join(run.workspaceRuntimeDir, "token-usage.json"),
      join(
        run.workspaceRuntimeDir,
        ".orchestrator",
        "runs",
        run.runId,
        "token-usage.json"
      ),
    ];

    for (const artifactPath of artifactPaths) {
      try {
        const raw = await readFile(artifactPath, "utf8");
        const tokenUsage = JSON.parse(
          raw
        ) as OrchestratorRunRecord["tokenUsage"];
        if (hasTokenUsage(tokenUsage)) {
          return tokenUsage;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Execute a workspace lifecycle hook using the workflow configuration
   * loaded from the repository. Returns the hook result or null if the
   * workflow could not be loaded.
   */
  private async runHook(
    kind: "after_create" | "before_run" | "after_run" | "before_remove",
    tenant: OrchestratorProjectConfig,
    repositoryDirectory: string,
    repository: RepositoryRef,
    context: {
      projectId: string;
      workspaceKey: string;
      issueSubjectId: string;
      issueIdentifier: string;
      workspacePath: string;
      repositoryPath: string;
      runId?: string;
      state?: string;
    },
    resolution?: ProjectWorkflowResolution
  ): Promise<HookResult | null> {
    try {
      const workflowResolution =
        resolution ?? (await this.loadProjectWorkflow(tenant, repository));
      if (!isUsableWorkflowResolution(workflowResolution)) {
        return null;
      }
      const hookEnv = this.buildProjectExecutionEnv(
        tenant.projectId,
        buildHookEnv(context)
      );
      return executeWorkspaceHook({
        kind,
        hooks: workflowResolution.workflow.hooks,
        repositoryPath: repositoryDirectory,
        env: hookEnv,
        trusted: isWorkflowHookExecutionAllowed(hookEnv),
        envAllowlist: parseCommaSeparatedEnvList(
          hookEnv[WORKFLOW_HOOK_ENV_ALLOWLIST_ENV]
        ),
        timeoutMs: workflowResolution.workflow.hooks.timeoutMs,
      });
    } catch {
      // If workflow cannot be loaded, skip hook execution
      return null;
    }
  }

  private readProjectEnv(projectId: string): Record<string, string> {
    const envPath = join(this.store.projectDir(projectId), ".env");
    try {
      return readEnvFile(envPath);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred.";
      (this.dependencies.stderr ?? process.stderr).write(
        `[warn] Failed to load project env for ${projectId} from ${envPath}: ${message}\n`
      );
      return {};
    }
  }

  private buildProjectExecutionEnv(
    projectId: string,
    env: Record<string, string | undefined>
  ): Record<string, string> {
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && shouldInheritProcessEnvKey(entry[0])
      )
    );
    const explicitEnv = Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );

    return {
      ...this.readProjectEnv(projectId),
      ...inheritedEnv,
      ...explicitEnv,
    };
  }

  private async restartRun(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord,
    issueRecords: IssueOrchestrationRecord[],
    now: Date,
    sessionId?: string | null
  ): Promise<{
    issueRecords: IssueOrchestrationRecord[];
    recovered: boolean;
  }> {
    // Mark the old retrying record as terminal BEFORE creating a new run.
    // Without this, the old record stays in the store with status "retrying"
    // and isActiveRunRecordStatus() picks it up on every tick, calling restartRun()
    // again each time → exponential run multiplication.
    const supersededRecord: OrchestratorRunRecord = {
      ...run,
      status: "failed",
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastError: "Superseded by recovered run.",
    };
    await this.store.saveRun(supersededRecord);

    const issue = resolveTrackerAdapter(tenant.tracker).reviveIssue(
      tenant,
      run
    );
    const recovery = await this.resolveRetryRunRecoveryContext(tenant, run);
    let nextIssueRecords = issueRecords;
    let preparedRun: OrchestratorRunRecord | null = null;
    let restarted: OrchestratorRunRecord;
    try {
      restarted = await this.startRun(tenant, issue, {
        recovery,
        onPrepared: async (candidate) => {
          preparedRun = candidate;
          nextIssueRecords = upsertIssueOrchestration(nextIssueRecords, {
            issueId: candidate.issueId,
            identifier: candidate.issueIdentifier,
            workspaceKey:
              candidate.issueWorkspaceKey ??
              deriveIssueWorkspaceKey(
                {
                  adapter: tenant.tracker.adapter,
                  issueSubjectId: candidate.issueSubjectId,
                },
                candidate.issueIdentifier
              ),
            state: "running",
            currentRunId: candidate.runId,
            retryEntry: null,
            updatedAt: now.toISOString(),
          });
          await this.store.saveRun(candidate);
          await this.store.saveProjectIssueOrchestrations(
            tenant.projectId,
            nextIssueRecords
          );
        },
      });
    } catch (error) {
      const failedPreparedRun = preparedRun as OrchestratorRunRecord | null;
      if (failedPreparedRun) {
        await this.store.saveRun({
          ...failedPreparedRun,
          status: "failed",
          completedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lastError: `Worker spawn failed: ${this.formatErrorMessage(error)}`,
        });
      }
      nextIssueRecords = releaseIssueOrchestration(
        nextIssueRecords,
        run.issueId,
        now
      );
      await this.store.saveProjectIssueOrchestrations(
        tenant.projectId,
        nextIssueRecords
      );
      throw error;
    }
    const recoveredRecord: OrchestratorRunRecord = {
      ...restarted,
      attempt: run.attempt,
      retryKind: run.retryKind ?? "recovery",
      createdAt: run.createdAt,
      issueWorkspaceKey: run.issueWorkspaceKey,
      threadId: null,
      cumulativeTurnCount: resolvePersistedCumulativeTurnCount(run),
      lastTurnSummary: run.lastTurnSummary ?? null,
      turnCount: 0,
    };
    await this.store.saveRun(recoveredRecord);
    await this.store.saveProjectIssueOrchestrations(
      tenant.projectId,
      nextIssueRecords
    );
    await this.store.appendRunEvent(run.runId, {
      at: now.toISOString(),
      event: "run-recovered",
      projectId: run.projectId,
      issueIdentifier: run.issueIdentifier,
      issueId: run.issueId,
      sessionId: sessionId ?? undefined,
    } as OrchestratorEvent);

    return {
      issueRecords: upsertIssueOrchestration(nextIssueRecords, {
        issueId: recoveredRecord.issueId,
        identifier: recoveredRecord.issueIdentifier,
        workspaceKey:
          recoveredRecord.issueWorkspaceKey ??
          deriveIssueWorkspaceKey(
            {
              adapter: tenant.tracker.adapter,
              issueSubjectId: recoveredRecord.issueSubjectId,
            },
            recoveredRecord.issueIdentifier
          ),
        state: "running",
        currentRunId: recoveredRecord.runId,
        retryEntry: null,
        updatedAt: now.toISOString(),
      }),
      recovered: true,
    };
  }

  private async releaseRetryingRun(
    run: OrchestratorRunRecord,
    issueRecords: IssueOrchestrationRecord[],
    now: Date
  ): Promise<{
    issueRecords: IssueOrchestrationRecord[];
    recovered: boolean;
  }> {
    const suppressedRun: OrchestratorRunRecord = {
      ...run,
      status: "suppressed",
      processId: null,
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRetryAt: null,
      runPhase: "canceled_by_reconciliation",
      lastError:
        "Retry canceled because the tracker issue is no longer actionable.",
    };
    await this.store.saveRun(suppressedRun);
    this.logVerbose(
      `[run-completed] ${suppressedRun.runId} status=${suppressedRun.status}`
    );

    return {
      issueRecords: releaseIssueOrchestration(issueRecords, run.issueId, now),
      recovered: false,
    };
  }

  private async loadProjectPollInterval(
    tenant: OrchestratorProjectConfig
  ): Promise<number> {
    const resolution = await this.loadProjectWorkflow(
      tenant,
      tenant.repository
    );
    const interval = isUsableWorkflowResolution(resolution)
      ? resolution.workflow.polling.intervalMs
      : NaN;
    return Number.isFinite(interval) && interval > 0
      ? interval
      : DEFAULT_POLL_INTERVAL_MS;
  }

  private async loadProjectMaxConcurrentByState(
    tenant: OrchestratorProjectConfig
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const resolution = await this.loadProjectWorkflow(
      tenant,
      tenant.repository
    ).catch(() => null);
    if (!resolution || !isUsableWorkflowResolution(resolution)) {
      return result;
    }

    const stateLimits = resolution.workflow.agent.maxConcurrentAgentsByState;
    for (const [state, limit] of Object.entries(stateLimits)) {
      result[state] = typeof limit === "number" ? limit : Number(limit);
    }

    return result;
  }

  private async loadRetryPolicy(
    tenant: OrchestratorProjectConfig,
    repository: RepositoryRef
  ): Promise<{
    baseDelayMs: number;
    maxDelayMs: number;
    stallTimeoutMs: number | null;
  } | null> {
    try {
      const resolution = await this.loadProjectWorkflow(tenant, repository);
      if (!isUsableWorkflowResolution(resolution)) {
        return null;
      }
      return {
        baseDelayMs:
          this.dependencies.retryBackoffMs ??
          resolution.workflow.agent.retryBaseDelayMs,
        maxDelayMs:
          this.dependencies.retryBackoffMs ??
          resolution.workflow.agent.maxRetryBackoffMs,
        stallTimeoutMs: resolveWorkflowRuntimeTimeouts(resolution.workflow)
          .stallTimeoutMs,
      };
    } catch {
      if (!this.dependencies.retryBackoffMs) {
        return null;
      }

      return {
        baseDelayMs: this.dependencies.retryBackoffMs,
        maxDelayMs: this.dependencies.retryBackoffMs,
        stallTimeoutMs: null,
      };
    }
  }

  private async getProjectConcurrency(
    project: OrchestratorProjectConfig
  ): Promise<number> {
    if (this.dependencies.concurrency !== undefined) {
      return this.dependencies.concurrency;
    }

    const limit = await this.loadProjectWorkflow(project, project.repository)
      .then((resolution) =>
        isUsableWorkflowResolution(resolution)
          ? resolution.workflow.agent.maxConcurrentAgents
          : NaN
      )
      .catch(() => NaN);
    return Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_CONCURRENCY;
  }

  private rememberTrackerRateLimits(
    projectId: string,
    rateLimits: Record<string, unknown> | null
  ): void {
    if (isTrackerGraphqlRateLimits(rateLimits)) {
      this.lastTrackerRateLimitsByProject.set(projectId, rateLimits);
    }
  }

  private async resolveWorkflowResolution(
    repository: RepositoryRef,
    cacheRoot: string,
    resolution: WorkflowResolution
  ): Promise<WorkflowResolution> {
    const cacheKey = this.workflowCacheKey(repository);

    if (resolution.isValid) {
      const effectiveResolution: WorkflowResolution = {
        ...resolution,
        isValid: true,
        usedLastKnownGood: false,
        validationError: null,
      };
      let workflowPath = effectiveResolution.workflowPath;
      try {
        workflowPath =
          (await this.persistLastKnownGoodWorkflow(
            cacheRoot,
            effectiveResolution
          )) ?? effectiveResolution.workflowPath;
      } catch {
        workflowPath = effectiveResolution.workflowPath;
      }
      this.lastKnownGoodWorkflows.set(cacheKey, {
        ...effectiveResolution,
        workflowPath,
      });
      return effectiveResolution;
    }

    const cached = this.lastKnownGoodWorkflows.get(cacheKey);
    const message =
      resolution.validationError ?? "Invalid repository WORKFLOW.md";
    this.writeStderr(
      `[orchestrator] failed to reload WORKFLOW.md for ${repository.owner}/${repository.name}: ${message}`
    );

    if (!cached) {
      return resolution;
    }

    return {
      ...cached,
      workflowPath: cached.workflowPath,
      isValid: false,
      usedLastKnownGood: true,
      validationError: message,
    };
  }

  private async persistLastKnownGoodWorkflow(
    cacheRoot: string,
    resolution: WorkflowResolution
  ): Promise<string | null> {
    if (!resolution.workflowPath) {
      return null;
    }

    const snapshotPath = this.lastKnownGoodWorkflowPath(cacheRoot);
    const markdown = await readFile(resolution.workflowPath, "utf8");
    await mkdir(join(cacheRoot, "last-known-good"), { recursive: true });
    await writeFile(snapshotPath, markdown, "utf8");
    return snapshotPath;
  }

  private lastKnownGoodWorkflowPath(cacheRoot: string): string {
    return join(cacheRoot, "last-known-good", "WORKFLOW.md");
  }

  private workflowCacheKey(repository: RepositoryRef): string {
    return `${repository.owner}/${repository.name}:${this.normalizeRepositoryCloneUrl(repository.cloneUrl)}`;
  }

  private resolveWorkflowRepositoryDirectory(
    repository: RepositoryRef
  ): string {
    if (repository.path) {
      return repository.path;
    }

    const localCloneUrlPath = this.resolveLocalCloneUrlPath(
      repository.cloneUrl
    );
    if (localCloneUrlPath) {
      return localCloneUrlPath;
    }

    return process.cwd();
  }

  private resolveLocalCloneUrlPath(cloneUrl: string): string | null {
    try {
      const url = new URL(cloneUrl);
      return url.protocol === "file:" ? fileURLToPath(url) : null;
    } catch {
      return isAbsolute(cloneUrl) || cloneUrl.startsWith(".") ? cloneUrl : null;
    }
  }

  private normalizeRepositoryCloneUrl(cloneUrl: string): string {
    if (cloneUrl.startsWith("file://")) {
      try {
        return fileURLToPath(cloneUrl);
      } catch {
        return cloneUrl;
      }
    }

    return cloneUrl;
  }

  private isProcessRunning(processId: number): boolean {
    if (this.dependencies.isProcessRunning) {
      return this.dependencies.isProcessRunning(processId);
    }
    // Check whether any process in the worker's process group is still alive.
    // Workers are spawned with detached:true, so the original PID is also the
    // PGID.  Checking -pid catches cases where bash -lc forked a child with a
    // different PID that is still running even though the original bash process
    // has exited.
    try {
      process.kill(-processId, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sendSignal(processId: number, signal: NodeJS.Signals): void {
    try {
      const kill = this.dependencies.killImpl;
      if (kill) {
        kill(processId, signal);
      } else {
        // Kill the entire process group (-pid) rather than just the leader.
        // Workers are spawned with detached:true, so processId equals the PGID.
        // This ensures that child processes (bash → node → codex agent) all
        // receive the signal even if bash has already exited.
        process.kill(-processId, signal);
      }
    } catch {
      this.retireWorkerPid(processId);
    }
  }

  private pruneExitedWorkerPids(): void {
    for (const pid of [...this.activeWorkerPids]) {
      if (!this.isProcessRunning(pid)) {
        this.retireWorkerPid(pid);
      }
    }
  }

  private retireWorkerPid(processId: number | null | undefined): void {
    if (processId) {
      this.activeWorkerPids.delete(processId);
    }
  }

  /**
   * Clean up the issue workspace for a terminal issue.
   *
   * Runs the `before_remove` hook if configured. Hook failures are logged and
   * ignored so workspace cleanup still proceeds per spec 9.4. The workspace
   * directory is removed and the record set to `removed`. Orchestration
   * records (runs) are preserved.
   */
  private async cleanupTerminalIssueWorkspace(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue,
    now: Date,
    workflowResolution?: ProjectWorkflowResolution
  ): Promise<void> {
    if (isArchivedProjectItem(issue)) {
      return;
    }

    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const preferredWorkspaceKey = deriveIssueWorkspaceKey(
      identity,
      issue.identifier
    );
    const legacyWorkspaceKey = deriveLegacyIssueWorkspaceKey(
      identity,
      tenant.projectId
    );
    const orchestrationRecord = (
      await this.store.loadProjectIssueOrchestrations(tenant.projectId)
    ).find((record) => record.issueId === issue.id);
    const workspaceRecord =
      (orchestrationRecord
        ? await this.store.loadIssueWorkspace(
            tenant.projectId,
            orchestrationRecord.workspaceKey
          )
        : null) ??
      (await this.store.loadIssueWorkspace(
        tenant.projectId,
        preferredWorkspaceKey
      )) ??
      (legacyWorkspaceKey === preferredWorkspaceKey
        ? null
        : await this.store.loadIssueWorkspace(
            tenant.projectId,
            legacyWorkspaceKey
          ));

    if (!workspaceRecord || workspaceRecord.status === "removed") {
      return;
    }

    // Transition to cleanup_pending
    const pendingRecord: IssueWorkspaceRecord = {
      ...workspaceRecord,
      status: "cleanup_pending",
      updatedAt: now.toISOString(),
    };
    await this.store.saveIssueWorkspace(pendingRecord);

    // Run before_remove hook. Failures are logged but do not block cleanup.
    const hookResult = await this.runHook(
      "before_remove",
      tenant,
      workspaceRecord.repositoryPath,
      issue.repository,
      {
        projectId: tenant.projectId,
        workspaceKey: workspaceRecord.workspaceKey,
        issueSubjectId,
        issueIdentifier: issue.identifier,
        workspacePath: workspaceRecord.workspacePath,
        repositoryPath: workspaceRecord.repositoryPath,
      },
      workflowResolution
    );

    if (
      hookResult &&
      hookResult.outcome !== "success" &&
      hookResult.outcome !== "skipped"
    ) {
      const errorMessage =
        hookResult.error ?? `before_remove hook ${hookResult.outcome}`;
      console.warn(
        `[orchestrator] before_remove hook failed for ${issue.identifier}; continuing cleanup: ${errorMessage}`
      );
    }

    // Hook succeeded or was skipped — remove workspace directory
    try {
      await rm(workspaceRecord.workspacePath, { recursive: true, force: true });
    } catch {
      // Directory removal failure is not fatal to the record transition
    }

    const removedRecord: IssueWorkspaceRecord = {
      ...workspaceRecord,
      status: "removed",
      updatedAt: now.toISOString(),
      lastError: null,
    };
    await this.store.saveIssueWorkspace(removedRecord);
  }

  private resolveFailureRetryCount(
    issueRecords: IssueOrchestrationRecord[],
    issueId: string
  ): number | null {
    return (
      issueRecords.find((record) => record.issueId === issueId)
        ?.failureRetryCount ?? null
    );
  }

  private async isFailureRetrySuppressedIssue(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue,
    issueRecords: IssueOrchestrationRecord[],
    latestRun: OrchestratorRunRecord | null
  ): Promise<boolean> {
    const issueRecord =
      issueRecords.find(
        (record) =>
          record.issueId === issue.id || record.identifier === issue.identifier
      ) ?? null;
    if (!issueRecord || issueRecord.failureRetryCount <= 0) {
      return false;
    }

    const maxFailureRetries = await this.loadMaxFailureRetries(
      tenant,
      issue.repository
    );
    if (issueRecord.failureRetryCount < maxFailureRetries) {
      return false;
    }

    if (
      !latestRun ||
      latestRun.status !== "suppressed" ||
      latestRun.issueState !== issue.state ||
      !latestRun.lastError?.includes(MAX_FAILURE_RETRIES_EXCEEDED_REASON)
    ) {
      return false;
    }

    const issueUpdatedAtMs = parseTimestampMs(issue.updatedAt);
    const suppressedAtMs = parseTimestampMs(
      latestRun.completedAt ?? latestRun.updatedAt
    );
    if (issueUpdatedAtMs === null || suppressedAtMs === null) {
      return true;
    }

    return issueUpdatedAtMs <= suppressedAtMs;
  }

  private async loadMaxFailureRetries(
    tenant: OrchestratorProjectConfig,
    repository: RepositoryRef
  ): Promise<number> {
    try {
      const resolution = await this.loadProjectWorkflow(tenant, repository);
      return isUsableWorkflowResolution(resolution)
        ? resolution.workflow.agent.maxFailureRetries
        : DEFAULT_MAX_FAILURE_RETRIES;
    } catch {
      return DEFAULT_MAX_FAILURE_RETRIES;
    }
  }
}

function shouldInheritProcessEnvKey(key: string): boolean {
  return INHERITED_ENV_ALLOWLIST.has(key) || key.startsWith("LC_");
}

function isWorkflowHookExecutionAllowed(env: Record<string, string>): boolean {
  const value =
    env[WORKFLOW_HOOK_APPROVAL_ENV] ?? process.env[WORKFLOW_HOOK_APPROVAL_ENV];
  return value === "1" || value?.toLowerCase() === "true";
}

function parseCommaSeparatedEnvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Z_][A-Z0-9_]*$/.test(entry));
}

function hasTokenUsage(
  tokenUsage: OrchestratorRunRecord["tokenUsage"] | undefined | null
): tokenUsage is NonNullable<OrchestratorRunRecord["tokenUsage"]> {
  return Boolean(
    tokenUsage &&
    (tokenUsage.inputTokens > 0 ||
      tokenUsage.outputTokens > 0 ||
      tokenUsage.totalTokens > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateTrackerStateRequest(
  request: TrackerStateRequest
): string | null {
  if (request.type === "state-read") {
    return null;
  }
  if (!request.expectedState.trim()) {
    return "expected_state_required";
  }
  if (!request.targetState.trim()) {
    return "target_state_required";
  }
  if (!request.reason.trim()) {
    return "transition_reason_required";
  }
  if (
    request.expectedState.length > 200 ||
    request.targetState.length > 200 ||
    request.reason.length > 2_000
  ) {
    return "tracker_state_request_too_large";
  }
  return null;
}

function extractTrackerRateLimitsFromError(
  error: unknown
): Record<string, unknown> | null {
  if (!isRecord(error)) {
    return null;
  }

  const rateLimits = error.rateLimits;
  if (!isRecord(rateLimits)) {
    return null;
  }

  return isTrackerGraphqlRateLimits(rateLimits) ? rateLimits : null;
}

function getTrackedIssueListRateLimits(
  issues: readonly TrackedIssue[]
): Record<string, unknown> | null {
  const rateLimits = (issues as TrackedIssueList).rateLimits;
  return isRecord(rateLimits) ? rateLimits : null;
}

function resolveProjectRateLimits(
  runs: Iterable<OrchestratorRunRecord>,
  issues: Iterable<TrackedIssue>,
  fallbackRateLimits: Record<string, unknown> | null = null
): Record<string, unknown> | null {
  let latestRunRateLimits: Record<string, unknown> | null = null;
  let latestRunTimestamp = -Infinity;

  for (const run of runs) {
    if (!isRecord(run.rateLimits)) {
      continue;
    }

    const timestamp = parseTimestampMs(
      run.lastEventAt ?? run.updatedAt ?? run.startedAt
    );
    const sortableTimestamp = timestamp ?? -Infinity;
    if (sortableTimestamp >= latestRunTimestamp) {
      latestRunTimestamp = sortableTimestamp;
      latestRunRateLimits = run.rateLimits;
    }
  }

  if (latestRunRateLimits) {
    return latestRunRateLimits;
  }

  for (const issue of issues) {
    if (isRecord(issue.rateLimits)) {
      return issue.rateLimits;
    }
  }

  return fallbackRateLimits;
}

function buildStructuredTrackerEventMetadata(
  tenant: OrchestratorProjectConfig,
  issue: TrackedIssue
): {
  tracker: { adapter: string; projectSlug?: string };
  issue: { identifier: string; id: string };
} {
  const projectSlug =
    typeof issue.metadata.projectSlug === "string"
      ? issue.metadata.projectSlug
      : tenant.tracker.adapter === "linear" &&
          typeof tenant.tracker.settings?.projectSlug === "string"
        ? tenant.tracker.settings.projectSlug
        : undefined;

  return {
    tracker: {
      adapter: issue.tracker.adapter,
      ...(projectSlug ? { projectSlug } : {}),
    },
    issue: {
      identifier: issue.identifier,
      id: issue.id,
    },
  };
}

function resolveTrackerRateLimits(
  issues: Iterable<TrackedIssue>,
  fallbackRateLimits: Record<string, unknown> | null = null
): Record<string, unknown> | null {
  for (const issue of issues) {
    if (isTrackerGraphqlRateLimits(issue.rateLimits)) {
      return issue.rateLimits;
    }
  }

  return isTrackerGraphqlRateLimits(fallbackRateLimits)
    ? fallbackRateLimits
    : null;
}

function resolveAdaptivePollIntervalMs(
  basePollIntervalMs: number,
  rateLimits: Record<string, unknown> | null
): number {
  if (!Number.isFinite(basePollIntervalMs) || basePollIntervalMs <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const ratio = extractRateLimitRatio(rateLimits);
  if (ratio === null || ratio > ADAPTIVE_RATE_LIMIT_FULL_SPEED_RATIO) {
    return basePollIntervalMs;
  }

  if (ratio <= 0) {
    return basePollIntervalMs * MAX_ADAPTIVE_POLL_INTERVAL_MULTIPLIER;
  }

  const multiplier = Math.min(
    MAX_ADAPTIVE_POLL_INTERVAL_MULTIPLIER,
    Math.max(1, ADAPTIVE_RATE_LIMIT_FULL_SPEED_RATIO / ratio)
  );
  return Math.ceil(basePollIntervalMs * multiplier);
}

function extractRateLimitRatio(
  rateLimits: Record<string, unknown> | null
): number | null {
  if (!isRecord(rateLimits)) {
    return null;
  }

  const limit = parseFiniteNumber(rateLimits.limit);
  const remaining = parseFiniteNumber(rateLimits.remaining);
  if (limit === null || remaining === null || limit <= 0 || remaining < 0) {
    return null;
  }

  return remaining / limit;
}

function isTrackerGraphqlRateLimits(
  rateLimits: Record<string, unknown> | null | undefined
): rateLimits is Record<string, unknown> {
  if (
    !isRecord(rateLimits) ||
    (rateLimits.source !== "github" && rateLimits.source !== "linear")
  ) {
    return false;
  }

  return (
    rateLimits.resource === undefined ||
    rateLimits.resource === null ||
    rateLimits.resource === "graphql"
  );
}

function isLowRateLimit(
  rateLimits: Record<string, unknown> | null,
  threshold: number
): boolean {
  const ratio = extractRateLimitRatio(rateLimits);
  return ratio !== null && ratio < threshold;
}

function resolveDispatchSuppressedUntil(
  lastError: string | null,
  rateLimits: Record<string, unknown> | null
): string | null {
  if (
    lastError !== "Rate limit near exhaustion" ||
    !isTrackerGraphqlRateLimits(rateLimits)
  ) {
    return null;
  }

  return typeof rateLimits.resetAt === "string" ? rateLimits.resetAt : null;
}

function buildRuntimeSession(
  existing: OrchestratorRunRecord["runtimeSession"] | null | undefined,
  sessionId: string | null,
  threadId: string | null,
  status: RuntimeSessionRow["status"],
  startedAt: string | null,
  updatedAt: string,
  exitClassification: SessionExitClassification | null | undefined = undefined
): OrchestratorRunRecord["runtimeSession"] | undefined {
  if (
    existing === undefined &&
    sessionId === null &&
    threadId === null &&
    status === null &&
    (exitClassification === undefined || exitClassification === null)
  ) {
    return undefined;
  }

  return {
    sessionId: sessionId ?? existing?.sessionId ?? null,
    threadId: threadId ?? existing?.threadId ?? null,
    status: status ?? existing?.status ?? null,
    startedAt: existing?.startedAt ?? startedAt,
    updatedAt,
    exitClassification:
      exitClassification === undefined
        ? (existing?.exitClassification ?? null)
        : exitClassification,
  };
}

function composeWorkerRunPrompt(
  issue: TrackedIssue,
  promptTemplate: string,
  promptVariables: ReturnType<typeof buildPromptVariables>,
  recovery: IncompleteTurnRecoveryContext | null
): string {
  const identityHeader = buildIssueIdentityHeader({
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    repositorySlug: `${issue.repository.owner}/${issue.repository.name}`,
  });
  const renderedPrompt = renderPrompt(promptTemplate, promptVariables);
  if (!recovery) {
    return [identityHeader, "", renderedPrompt].join("\n");
  }

  return [
    identityHeader,
    "",
    renderedPrompt,
    "",
    "## Recovery Context — Incomplete Turn Dirty Workspace",
    "",
    `Previous run: ${recovery.runId}`,
    `Workspace: ${recovery.workspacePath}`,
    `Last event: ${recovery.lastEvent ?? "unknown"}`,
    `Last event time: ${recovery.lastEventAt ?? "unknown"}`,
    `Session id: ${recovery.sessionId ?? "unknown"}`,
    `Thread id: ${recovery.threadId ?? "unknown"}`,
    "",
    "Dirty files:",
    ...formatRecoveryDirtyFileLinesForPrompt(recovery.dirtyFiles),
    "",
    `Inspect the dirty diff before editing. This dirty state was attributed to ${issue.identifier}; if any artifact turns out to belong to a different issue, stop and record a blocker instead of committing it. If the partial work is correct, validate it, commit it, and push it to this issue's branch only. If it is invalid, revert it explicitly and record a blocker/comment with the reason. Do not discard uncommitted work without making an intentional recovery decision.`,
    `Suggested operator command: ${recovery.suggestedCommand}`,
  ].join("\n");
}

function formatRecoveryDirtyFilesForContext(dirtyFiles: string[]): string {
  return formatRecoveryDirtyFiles(dirtyFiles).join("\n");
}

function formatRecoveryDirtyFileLinesForPrompt(dirtyFiles: string[]): string[] {
  return formatRecoveryDirtyFiles(dirtyFiles).map((file) => `- ${file}`);
}

function formatRecoveryDirtyFiles(dirtyFiles: string[]): string[] {
  const visibleFiles = dirtyFiles.slice(0, MAX_RECOVERY_DIRTY_FILES_IN_CONTEXT);
  const remaining = dirtyFiles.length - visibleFiles.length;
  if (remaining <= 0) {
    return visibleFiles;
  }

  return [...visibleFiles, `... and ${remaining} more`];
}

function resolvePersistedCumulativeTurnCount(
  run: OrchestratorRunRecord
): number {
  return run.cumulativeTurnCount ?? run.turnCount ?? 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveCumulativeTurnCount(
  run: OrchestratorRunRecord,
  turnCount: number | null
): number {
  const carriedTotal = resolvePersistedCumulativeTurnCount(run);
  if (turnCount === null) {
    return carriedTotal;
  }

  const previousSessionTurnCount = run.turnCount ?? 0;
  const baseTurnCount = Math.max(0, carriedTotal - previousSessionTurnCount);
  return baseTurnCount + turnCount;
}

function isTerminalTurnEvent(event: string | null | undefined): boolean {
  return (
    event === "turn/completed" ||
    event === "turn/failed" ||
    event === "turn/cancelled"
  );
}

function resolveLastTurnSummaryCandidate(
  event: string | null | undefined,
  lastError: string | null | undefined
): string | null {
  if (typeof lastError === "string" && lastError.trim()) {
    return lastError.trim();
  }

  return typeof event === "string" && isTerminalTurnEvent(event) ? event : null;
}

function resolveLastTurnSummary(
  existing: string | null | undefined,
  candidate: string | null | undefined
): string | null {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }

  return existing ?? null;
}

function canApplyWorkerChannelUpdate(
  status: OrchestratorRunRecord["status"]
): boolean {
  return status === "running" || status === "retrying";
}

function resolveChannelSessionId(
  sessionInfo: OrchestratorChannelSessionInfo | null | undefined
): string | null {
  if (!sessionInfo) {
    return null;
  }

  return (
    sessionInfo.sessionId ??
    (sessionInfo.threadId && sessionInfo.turnId
      ? `${sessionInfo.threadId}-${sessionInfo.turnId}`
      : null)
  );
}

function resolveWorkerCommand(): string {
  if (process.env.SYMPHONY_WORKER_COMMAND) {
    return process.env.SYMPHONY_WORKER_COMMAND;
  }
  try {
    const workerUrl = import.meta.resolve("@gh-symphony/worker");
    return `node ${fileURLToPath(workerUrl)}`;
  } catch {
    // When running from the bundled CLI, resolve worker-entry.js next to this file.
    try {
      const bundledWorker = join(
        fileURLToPath(new URL(".", import.meta.url)),
        "worker-entry.js"
      );
      return `node ${bundledWorker}`;
    } catch {
      return DEFAULT_WORKER_COMMAND;
    }
  }
}

export function createStore(
  runtimeRoot = ".runtime",
  options: {
    eventsMirrorRoot?: string;
  } = {}
) {
  return new OrchestratorFsStore(runtimeRoot, options);
}

/**
 * Sort dispatch candidates by priority (ascending, null last), then
 * createdAt (oldest first, null last), then identifier (lexicographic).
 */
export function sortCandidatesForDispatch(
  candidates: TrackedIssue[]
): TrackedIssue[] {
  return [...candidates].sort((a, b) => {
    // 1. Priority ascending (null last)
    if (a.priority !== b.priority) {
      if (a.priority === null) return 1;
      if (b.priority === null) return -1;
      return a.priority - b.priority;
    }
    // 2. createdAt oldest first (null last)
    if (a.createdAt !== b.createdAt) {
      if (a.createdAt === null) return 1;
      if (b.createdAt === null) return -1;
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    // 3. identifier lexicographic
    return a.identifier.localeCompare(b.identifier);
  });
}

function createProjectItemsCache(): ProjectItemsCache {
  const entries = new Map<string, Promise<TrackedIssue[]>>();

  return {
    getOrLoad(key, load) {
      const cached = entries.get(key);
      if (cached) {
        return cached;
      }

      const pending = load().catch((error) => {
        entries.delete(key);
        throw error;
      });
      entries.set(key, pending);
      return pending;
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRunId(
  now: Date,
  projectId: string,
  issueIdentifier: string
): string {
  return [
    projectId,
    issueIdentifier.replace(/[^a-zA-Z0-9]+/g, "-"),
    now.getTime().toString(36),
  ].join("-");
}

function buildLatestRunMapByIssueId(
  runs: OrchestratorRunRecord[]
): Map<string, OrchestratorRunRecord> {
  const latestRuns = new Map<string, OrchestratorRunRecord>();
  for (const run of runs) {
    const existing = latestRuns.get(run.issueId);
    if (!existing) {
      latestRuns.set(run.issueId, run);
      continue;
    }

    const runUpdatedAtMs = parseTimestampMs(run.updatedAt) ?? -Infinity;
    const existingUpdatedAtMs =
      parseTimestampMs(existing.updatedAt) ?? -Infinity;
    if (runUpdatedAtMs > existingUpdatedAtMs) {
      latestRuns.set(run.issueId, run);
    }
  }

  return latestRuns;
}

function upsertIssueOrchestration(
  issueRecords: IssueOrchestrationRecord[],
  nextRecord: Omit<
    IssueOrchestrationRecord,
    "completedOnce" | "failureRetryCount"
  > & {
    completedOnce?: boolean;
    failureRetryCount?: number;
  }
): IssueOrchestrationRecord[] {
  const existingRecord =
    issueRecords.find((record) => record.issueId === nextRecord.issueId) ??
    null;
  const remaining = issueRecords.filter(
    (record) => record.issueId !== nextRecord.issueId
  );
  return [
    ...remaining,
    {
      ...nextRecord,
      completedOnce:
        nextRecord.completedOnce ?? existingRecord?.completedOnce ?? false,
      failureRetryCount:
        nextRecord.failureRetryCount ?? existingRecord?.failureRetryCount ?? 0,
    },
  ];
}

function releaseIssueOrchestration(
  issueRecords: IssueOrchestrationRecord[],
  issueId: string,
  now: Date
): IssueOrchestrationRecord[] {
  return issueRecords.map((record) =>
    record.issueId === issueId
      ? {
          ...record,
          state: "released",
          currentRunId: null,
          retryEntry: null,
          updatedAt: now.toISOString(),
        }
      : record
  );
}

function isArchivedProjectItem(issue: TrackedIssue): boolean {
  return issue.metadata.isArchived === true;
}

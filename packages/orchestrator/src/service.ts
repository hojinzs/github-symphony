import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  buildHookEnv,
  buildPromptVariables,
  buildProjectSnapshot,
  deriveIssueWorkspaceKey,
  deriveLegacyIssueWorkspaceKey,
  executeWorkspaceHook,
  isWorkflowExecutionPhase,
  isRunAttemptPhase,
  isStateActive,
  isStateTerminal,
  matchesWorkflowState,
  readEnvFile,
  renderPrompt,
  resolveIssueWorkspaceDirectory,
  scheduleRetryAt,
  type HookResult,
  type IssueOrchestrationRecord,
  type IssueStatusSnapshot,
  type IssueSubjectIdentity,
  type IssueWorkspaceRecord,
  type OrchestratorRunRecord,
  type OrchestratorEvent,
  type OrchestratorStateStore,
  type OrchestratorProjectConfig,
  type OrchestratorTrackerDependencies,
  type OrchestratorTrackerAdapter,
  type ProjectItemsCache,
  type ProjectStatusSnapshot,
  type RepositoryRef,
  type RuntimeSessionRow,
  type RunAttemptPhase,
  type TrackedIssue,
  type WorkflowLifecycleConfig,
  type WorkflowResolution,
} from "@gh-symphony/core";
import {
  ensureIssueWorkspaceRepository,
  loadRepositoryWorkflow,
  syncRepositoryForRun,
} from "./git.js";
import { OrchestratorFsStore } from "./fs-store.js";
import { resolveTrackerAdapter } from "./tracker-adapters.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_PORT_BASE = 4600;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const CONTINUATION_RETRY_DELAY_MS = 1_000;
const DEFAULT_WORKER_COMMAND = "node packages/worker/dist/index.js";

type ProjectWorkflowResolution = Awaited<
  ReturnType<typeof loadRepositoryWorkflow>
>;
             
const STUCK_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export type OrchestratorLogLevel = "normal" | "verbose";

function parseExecutionPhase(value: unknown) {
  return isWorkflowExecutionPhase(value) ? value : null;
}

function parseRunPhase(value: unknown): RunAttemptPhase | null {
  return isRunAttemptPhase(value) ? value : null;
}

function isUsableWorkflowResolution(
  resolution: WorkflowResolution
): boolean {
  return resolution.isValid || resolution.usedLastKnownGood;
}

function isMatchingIssueRun(
  run: OrchestratorRunRecord | null,
  projectId: string,
  issueId: string,
  issueIdentifier: string
): run is OrchestratorRunRecord {
  return Boolean(
    run &&
      run.projectId === projectId &&
      (run.issueId === issueId || run.issueIdentifier === issueIdentifier)
  );
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export class OrchestratorService {
  private nextPort = DEFAULT_PORT_BASE;
  private readonly projectPollIntervals = new Map<string, number>();
  private readonly activeWorkerPids = new Set<number>();
  private readonly lastKnownGoodWorkflows = new Map<string, WorkflowResolution>();
  private readonly lastReportedWorkflowErrors = new Map<string, string>();
  private workflowResolutionCache: Map<string, Promise<WorkflowResolution>> | null =
    null;
  private running = true;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;
  private reconcilePromise: Promise<void> = Promise.resolve();

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
      killImpl?: (pid: number, signal?: NodeJS.Signals) => void;
      isProcessRunning?: (pid: number) => boolean;
      waitImpl?: (ms: number) => Promise<void>;
      stderr?: Pick<NodeJS.WriteStream, "write">;
      logLevel?: OrchestratorLogLevel;
    } = {}
  ) {}

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
      await this.runOnceInternal(
        options.issueIdentifier,
        this.createTrackerDependencies()
      );

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
      this.projectConfig.projectId,
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
              due_at:
                currentRun?.nextRetryAt ?? issueRecord.retryEntry?.dueAt ?? "",
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
                  path: join(
                    this.store.runDir(currentRun.runId, currentRun.projectId),
                    "worker.log"
                  ),
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

  async recover(): Promise<ProjectStatusSnapshot> {
    return this.runOnce();
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

    let issueRecords =
      await this.store.loadProjectIssueOrchestrations(tenant.projectId);
    const allRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.projectId === tenant.projectId
    );
    const activeRuns = allRuns.filter((run) => isActiveRunStatus(run.status));
    this.initializePortFrom(allRuns);

    for (const run of activeRuns) {
      const outcome = await this.reconcileRun(tenant, run, issueRecords);
      issueRecords = outcome.issueRecords;
      if (outcome.recovered) {
        recovered += 1;
      }
    }
    const reconciledRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.projectId === tenant.projectId && isActiveRunStatus(run.status)
    );
    rateLimits = resolveProjectRateLimits(reconciledRuns, []);

    try {
      pollIntervalMs = await this.loadProjectPollInterval(tenant);
      const currentActiveRuns = (await this.store.loadAllRuns()).filter(
        (run) =>
          run.projectId === tenant.projectId && isActiveRunStatus(run.status)
      );
      const {
        runs: syncedActiveRuns,
        issuesByIdentifier: syncedIssuesByIdentifier,
      } = await this.syncActiveRunIssueStates(
        tenant,
        trackerAdapter,
        currentActiveRuns,
        now
      );
      const issues = await trackerAdapter.listIssues(tenant, trackerDependencies);
      const filteredIssues = issueIdentifier
        ? issues.filter(
            (issue: TrackedIssue) => issue.identifier === issueIdentifier
          )
        : issues;
      const { candidates: actionableCandidates, lifecycle } =
        await this.resolveActionableCandidates(tenant, filteredIssues);
      const trackedIssuesByIdentifier = new Map<string, TrackedIssue>(
        syncedIssuesByIdentifier
      );
      for (const issue of filteredIssues) {
        const existing = trackedIssuesByIdentifier.get(issue.identifier);
        trackedIssuesByIdentifier.set(issue.identifier, {
          ...(existing ?? issue),
          ...issue,
          rateLimits: issue.rateLimits ?? existing?.rateLimits ?? null,
        });
      }
      for (const [identifier, issue] of syncedIssuesByIdentifier) {
        const existing = trackedIssuesByIdentifier.get(identifier);
        if (!existing) {
          trackedIssuesByIdentifier.set(identifier, issue);
          continue;
        }
        trackedIssuesByIdentifier.set(identifier, {
          ...issue,
          ...existing,
          rateLimits: existing.rateLimits ?? issue.rateLimits ?? null,
        });
      }
      rateLimits = resolveProjectRateLimits(
        syncedActiveRuns,
        trackedIssuesByIdentifier.values()
      );
      const concurrency = await this.getProjectConcurrency(tenant);
      const currentlyActive = issueRecords.filter((record) =>
        isIssueOrchestrationClaimed(record.state)
      ).length;
      const availableSlots = Math.max(0, concurrency - currentlyActive);

      const unscheduledCandidates = actionableCandidates.filter((issue) => {
        return !issueRecords.some(
          (record) =>
            record.issueId === issue.id &&
            isIssueOrchestrationClaimed(record.state)
        );
      });

      // Sort candidates by priority (asc, null last) → createdAt (oldest) → identifier (lexicographic)
      const sortedCandidates = sortCandidatesForDispatch(unscheduledCandidates);

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
            projectId: tenant.projectId,
            adapter: issue.tracker.adapter,
            issueSubjectId: issue.id,
          },
          issue.identifier
        );
        issueRecords = upsertIssueOrchestration(issueRecords, {
          issueId: issue.id,
          identifier: issue.identifier,
          workspaceKey: preferredWorkspaceKey,
          state: "claimed",
          currentRunId: null,
          retryEntry: null,
          updatedAt: now.toISOString(),
        });
        let run: OrchestratorRunRecord;
        try {
          run = await this.startRun(tenant, issue);
        } catch (error) {
          issueRecords = releaseIssueOrchestration(issueRecords, issue.id, now);
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
        await this.store.appendRunEvent(run.runId, {
          at: now.toISOString(),
          event: "run-dispatched",
          projectId: tenant.projectId,
          issueIdentifier: issue.identifier,
          issueId: run.issueId,
          issueState: issue.state,
        });
        this.logVerbose(
          `[dispatch] Issue ${issue.identifier} → run ${run.runId} (port=${run.port ?? "unknown"})`
        );
        dispatched += 1;
        slotsRemaining -= 1;
        activeByState.set(
          issue.state,
          (activeByState.get(issue.state) ?? 0) + 1
        );
      }

      for (const issueRecord of issueRecords) {
        if (!isIssueOrchestrationClaimed(issueRecord.state)) {
          continue;
        }

        const issue = trackedIssuesByIdentifier.get(issueRecord.identifier);
        if (!issue) {
          continue;
        }

        const persistedRun = issueRecord.currentRunId
          ? await this.store.loadRun(issueRecord.currentRunId, tenant.projectId)
          : null;
        const activeRun =
          syncedActiveRuns.find((run) =>
            isMatchingIssueRun(
              run,
              tenant.projectId,
              issueRecord.issueId,
              issueRecord.identifier
            )
          ) ?? persistedRun;
        const resolvedIssue = actionableCandidates.find(
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
          const suppressedRun: OrchestratorRunRecord = {
            ...activeRun,
            status: "suppressed",
            processId: null,
            completedAt: now.toISOString(),
            updatedAt: now.toISOString(),
            runPhase: "canceled_by_reconciliation",
            lastError:
              "Run suppressed because the tracker state is no longer actionable.",
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
        if (!isStateTerminal(issue.state, lifecycle)) {
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
    }

    this.projectPollIntervals.set(tenant.projectId, pollIntervalMs);
    await this.store.saveProjectIssueOrchestrations(
      tenant.projectId,
      issueRecords
    );

    const allTenantRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.projectId === tenant.projectId
    );
    const latestRuns = allTenantRuns.filter((run) =>
      isActiveRunStatus(run.status)
    );
    rateLimits = rateLimits ?? resolveProjectRateLimits(latestRuns, []);
    const status = buildProjectSnapshot({
      project: tenant,
      activeRuns: latestRuns,
      allRuns: allTenantRuns,
      summary: { dispatched, suppressed, recovered },
      lastTickAt: now.toISOString(),
      lastError,
      rateLimits,
    });
    await this.store.saveProjectStatus(status);
    return status;
  }

  private async performStartupCleanup(
    trackerDependencies: OrchestratorTrackerDependencies = {}
  ): Promise<void> {
    const tenant = this.projectConfig;
    const now = this.now();
    const workspaceRecords = await this.store.loadIssueWorkspaces(tenant.projectId);
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
      if (
        workspaceRecord.status === "removed" ||
        workspaceRecord.status === "cleanup_blocked"
      ) {
        continue;
      }

      const issue = issuesById.get(workspaceRecord.issueSubjectId);
      if (!issue) {
        continue;
      }

      try {
        const resolution = await this.loadStartupCleanupWorkflow(
          tenant,
          issue.repository,
          workflowCache
        );

        if (!resolution.isValid) {
          continue;
        }
        if (!isStateTerminal(issue.state, resolution.lifecycle)) {
          continue;
        }

        await this.cleanupTerminalIssueWorkspace(tenant, issue, now, resolution);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown startup cleanup error";
        console.warn(
          `[orchestrator] Startup cleanup skipped workspace for ${issue.identifier}: ${message}`
        );
      }
    }
  }

  private async resolveStartupCleanupTerminalStates(
    tenant: OrchestratorProjectConfig,
    workspaceRecords: readonly IssueWorkspaceRecord[],
    workflowCache: Map<string, Promise<ProjectWorkflowResolution>>
  ): Promise<string[]> {
    const terminalStates = new Map<string, string>();
    const repositories = this.resolveStartupCleanupRepositories(
      tenant,
      workspaceRecords
    );

    for (const repository of repositories) {
      let resolution: ProjectWorkflowResolution;
      try {
        resolution = await this.loadStartupCleanupWorkflow(
          tenant,
          repository,
          workflowCache
        );
      } catch {
        continue;
      }
      if (!isUsableWorkflowResolution(resolution)) {
        continue;
      }

      for (const state of resolution.lifecycle.terminalStates) {
        const normalizedState = state.trim().toLowerCase();
        if (!terminalStates.has(normalizedState)) {
          terminalStates.set(normalizedState, state);
        }
      }
    }

    if (terminalStates.size === 0) {
      for (const state of DEFAULT_WORKFLOW_LIFECYCLE.terminalStates) {
        terminalStates.set(state.trim().toLowerCase(), state);
      }
    }

    return [...terminalStates.values()];
  }

  private resolveStartupCleanupRepositories(
    tenant: OrchestratorProjectConfig,
    workspaceRecords: readonly IssueWorkspaceRecord[]
  ): RepositoryRef[] {
    const repositories = new Map<string, RepositoryRef>();

    for (const repository of tenant.repositories) {
      repositories.set(
        this.startupCleanupRepositoryKey(repository.owner, repository.name),
        repository
      );
    }

    for (const workspaceRecord of workspaceRecords) {
      const repository = this.parseWorkspaceRepositoryRef(workspaceRecord);
      if (!repository) {
        continue;
      }

      const key = this.startupCleanupRepositoryKey(
        repository.owner,
        repository.name
      );
      if (!repositories.has(key)) {
        repositories.set(key, repository);
      }
    }

    return [...repositories.values()];
  }

  private parseWorkspaceRepositoryRef(
    workspaceRecord: IssueWorkspaceRecord
  ): RepositoryRef | null {
    const match = workspaceRecord.issueIdentifier.match(
      /^([^/]+)\/([^#]+)#\d+$/
    );
    if (!match) {
      return null;
    }

    const owner = match[1];
    const name = match[2];
    if (!owner || !name) {
      return null;
    }

    return {
      owner,
      name,
      cloneUrl: workspaceRecord.repositoryPath,
    };
  }

  private startupCleanupRepositoryKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  private async loadStartupCleanupWorkflow(
    tenant: OrchestratorProjectConfig,
    repository: RepositoryRef,
    workflowCache: Map<string, Promise<ProjectWorkflowResolution>>
  ): Promise<ProjectWorkflowResolution> {
    const cacheKey = this.workflowCacheKey(repository);
    const cachedResolution = workflowCache.get(cacheKey);
    if (cachedResolution) {
      return cachedResolution;
    }

    const resolutionPromise = tenant.repositories.some(
      (candidate) =>
        candidate.owner === repository.owner && candidate.name === repository.name
    )
      ? this.loadProjectWorkflow(tenant, repository)
      : loadRepositoryWorkflow(repository.cloneUrl, repository);
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
      fetchImpl: this.dependencies.fetchImpl,
      projectItemsCache: createProjectItemsCache(),
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
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );

    return matchingRuns[0] ?? null;
  }

  private async resolveActionableCandidates(
    tenant: OrchestratorProjectConfig,
    issues: TrackedIssue[]
  ): Promise<{
    candidates: TrackedIssue[];
    lifecycle: WorkflowLifecycleConfig;
  }> {
    const candidates: TrackedIssue[] = [];
    let lifecycle: WorkflowLifecycleConfig | null = null;

    for (const issue of issues) {
      const resolution = await this.loadProjectWorkflow(
        tenant,
        issue.repository
      );
      if (!isUsableWorkflowResolution(resolution)) {
        continue;
      }
      if (!lifecycle) {
        lifecycle = resolution.lifecycle;
      }

      if (!isStateActive(issue.state, resolution.lifecycle)) {
        continue;
      }

      // Blocker eligibility: skip blocker-check-state issues with non-terminal blockers
      if (
        matchesWorkflowState(
          issue.state,
          resolution.lifecycle.blockerCheckStates
        ) &&
        issue.blockedBy.length > 0
      ) {
        const hasNonTerminalBlocker = issue.blockedBy.some((blockerRef) => {
          if (
            blockerRef.state &&
            isStateTerminal(blockerRef.state, resolution.lifecycle)
          ) {
            return false;
          }

          if (blockerRef.identifier) {
            const blockerIssue = issues.find(
              (candidate) => candidate.identifier === blockerRef.identifier
            );
            if (blockerIssue?.state) {
              return !isStateTerminal(
                blockerIssue.state,
                resolution.lifecycle
              );
            }
          }

          return true;
        });
        if (hasNonTerminalBlocker) {
          continue;
        }
      }

      candidates.push(issue);
    }

    // If no issues were processed, load lifecycle from first repo
    if (!lifecycle && tenant.repositories.length > 0) {
      const resolution = await this.loadProjectWorkflow(
        tenant,
        tenant.repositories[0]!
      );
      if (isUsableWorkflowResolution(resolution)) {
        lifecycle = resolution.lifecycle;
      }
    }

    return {
      candidates,
      lifecycle: lifecycle ?? {
        stateFieldName: "Status",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done"],
        blockerCheckStates: ["Todo"],
      },
    };
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
    const { repositoryDirectory, changed } = await syncRepositoryForRun({
      repository,
      targetDirectory: cacheRoot,
    });
    const resolution = await loadRepositoryWorkflow(repositoryDirectory, repository);
    return this.resolveWorkflowResolution(
      repository,
      cacheRoot,
      resolution,
      changed
    );
  }

  private async startRun(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue
  ): Promise<OrchestratorRunRecord> {
    if (this.shuttingDown || !this.running) {
      throw new Error("Orchestrator is shutting down and cannot start new runs.");
    }

    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const now = this.now();
    const runId = createRunId(now, tenant.projectId, issue.identifier);
    const runDir = this.store.runDir(runId, tenant.projectId);
    const workspaceRuntimeDir = runDir;

    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      projectId: tenant.projectId,
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const preferredWorkspaceKey = deriveIssueWorkspaceKey(
      identity,
      issue.identifier
    );
    const legacyWorkspaceKey = deriveLegacyIssueWorkspaceKey(identity);
    const existingWorkspaceRecord =
      (await this.store.loadIssueWorkspace(tenant.projectId, preferredWorkspaceKey)) ??
      (legacyWorkspaceKey === preferredWorkspaceKey
        ? null
        : await this.store.loadIssueWorkspace(tenant.projectId, legacyWorkspaceKey));
    const workspaceKey =
      existingWorkspaceRecord?.workspaceKey ?? preferredWorkspaceKey;
    const projectDir = this.store.projectDir(tenant.projectId);
    const issueWorkspacePath = resolveIssueWorkspaceDirectory(
      projectDir,
      workspaceKey
    );

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository: issue.repository,
      issueWorkspacePath,
    });

    if (!existingWorkspaceRecord) {
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
    const port = await this.allocatePort();

    // Render the issue prompt from the workflow template
    const promptVariables = buildPromptVariables(issue, {
      attempt: null, // first execution
    });
    const renderedPrompt = renderPrompt(
      workflow.promptTemplate,
      promptVariables
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

    mkdirSync(runDir, { recursive: true });
    const workerLogFd = openSync(join(runDir, "worker.log"), "a");
    const child = (this.dependencies.spawnImpl ?? spawn)(
      "bash",
      ["-lc", resolveWorkerCommand()],
      {
        cwd: process.cwd(),
        env: this.buildProjectExecutionEnv(tenant.projectId, {
          GITHUB_GRAPHQL_TOKEN: process.env.GITHUB_GRAPHQL_TOKEN ?? "",
          CODEX_PROJECT_ID: tenant.projectId,
          PROJECT_ID: tenant.projectId,
          WORKING_DIRECTORY: repositoryDirectory,
          WORKSPACE_RUNTIME_DIR: workspaceRuntimeDir,
          PORT: String(port),
          SYMPHONY_PORT: String(port),
          SYMPHONY_RUN_ID: runId,
          SYMPHONY_ISSUE_STATE: issue.state,
          SYMPHONY_ISSUE_ID: issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
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
          SYMPHONY_AGENT_COMMAND: workflow.workflow.codex.command,
          SYMPHONY_APPROVAL_POLICY:
            workflow.workflow.codex.approvalPolicy ?? "",
          SYMPHONY_THREAD_SANDBOX:
            workflow.workflow.codex.threadSandbox ?? "",
          SYMPHONY_TURN_SANDBOX_POLICY:
            workflow.workflow.codex.turnSandboxPolicy ?? "",
          SYMPHONY_MAX_TURNS: String(workflow.workflow.agent.maxTurns),
          SYMPHONY_READ_TIMEOUT_MS: String(
            workflow.workflow.codex.readTimeoutMs
          ),
          SYMPHONY_TURN_TIMEOUT_MS: String(
            workflow.workflow.codex.turnTimeoutMs
          ),
        }),
        detached: true,
        stdio: ["ignore", "ignore", workerLogFd],
      }
    );

    if (child.pid) {
      this.activeWorkerPids.add(child.pid);
      this.logVerbose(`[worker-started] ${runId} (pid=${child.pid})`);
    }
    child.on?.("exit", (code, signal) => {
      if (child.pid) {
        this.retireWorkerPid(child.pid);
      }
      this.logVerbose(
        `[worker-exited] ${runId} (code=${code ?? "null"}, signal=${signal ?? "null"})`
      );
    });
    child.unref();

    return {
      runId,
      projectId: tenant.projectId,
      projectSlug: tenant.slug,
      issueId: issue.id,
      issueSubjectId,
      issueIdentifier: issue.identifier,
      issueState: issue.state,
      repository: issue.repository,
      status: "running",
      attempt: 1,
      processId: child.pid ?? null,
      port,
      workingDirectory: repositoryDirectory,
      issueWorkspaceKey: workspaceKey,
      workspaceRuntimeDir,
      workflowPath: workflow.workflowPath,
      retryKind: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      runPhase: "preparing_workspace",
      rateLimits: issue.rateLimits ?? null,
    };
  }

  private async syncActiveRunIssueStates(
    tenant: OrchestratorProjectConfig,
    trackerAdapter: OrchestratorTrackerAdapter,
    activeRuns: OrchestratorRunRecord[],
    now: Date
  ): Promise<{
    runs: OrchestratorRunRecord[];
    issuesByIdentifier: Map<string, TrackedIssue>;
  }> {
    const activeIssueIds = [...new Set(activeRuns.map((run) => run.issueId))];
    if (activeIssueIds.length === 0) {
      return {
        runs: activeRuns,
        issuesByIdentifier: new Map(),
      };
    }

    const issues = await trackerAdapter.fetchIssueStatesByIds(
      tenant,
      activeIssueIds,
      {
        fetchImpl: this.dependencies.fetchImpl,
      }
    );
    const issuesByIdentifier = new Map<string, TrackedIssue>(
      issues.map((issue) => [issue.identifier, issue])
    );
    const issueStateByIdentifier = new Map<string, TrackedIssue["state"]>(
      issues.map((issue) => [issue.identifier, issue.state])
    );

    const syncedRuns: OrchestratorRunRecord[] = [];
    for (const run of activeRuns) {
      const currentTrackerState = issueStateByIdentifier.get(run.issueIdentifier);
      if (!currentTrackerState || currentTrackerState === run.issueState) {
        syncedRuns.push(run);
        continue;
      }

      const updatedRun: OrchestratorRunRecord = {
        ...run,
        issueState: currentTrackerState,
        updatedAt: now.toISOString(),
      };
      await this.store.saveRun(updatedRun);
      syncedRuns.push(updatedRun);
    }

    return {
      runs: syncedRuns,
      issuesByIdentifier,
    };
  }

  private async reconcileRun(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord,
    issueRecords: IssueOrchestrationRecord[]
  ): Promise<{
    issueRecords: IssueOrchestrationRecord[];
    recovered: boolean;
  }> {
    const now = this.now();

    if (run.processId && this.isProcessRunning(run.processId)) {
      const retryPolicy = await this.loadRetryPolicy(tenant, run.repository);
      const configuredStallTimeoutMs = retryPolicy?.stallTimeoutMs ?? null;
      const lastActivityAtMs = parseTimestampMs(run.lastEventAt ?? run.startedAt);
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
        const liveState = await this.fetchLiveWorkerState(run);
        const runningRecord: OrchestratorRunRecord = {
          ...run,
          status: "running",
          updatedAt: now.toISOString(),
          runtimeSession: buildRuntimeSession(
            run.runtimeSession,
            liveState.sessionId,
            liveState.threadId,
            "active",
            run.startedAt ?? now.toISOString(),
            now.toISOString()
          ),
          turnCount: liveState.turnCount ?? undefined,
          tokenUsage: liveState.tokenUsage ?? run.tokenUsage,
          lastEvent: liveState.lastEvent ?? undefined,
          lastEventAt: liveState.lastEventAt ?? run.lastEventAt ?? undefined,
          executionPhase: liveState.executionPhase ?? run.executionPhase ?? null,
          runPhase: liveState.runPhase ?? run.runPhase ?? "streaming_turn",
          rateLimits: liveState.rateLimits ?? run.rateLimits ?? null,
        };
        await this.store.saveRun(runningRecord);
        issueRecords = upsertIssueOrchestration(issueRecords, {
          issueId: run.issueId,
          identifier: run.issueIdentifier,
          workspaceKey:
            run.issueWorkspaceKey ??
            deriveIssueWorkspaceKey(
              {
                projectId: tenant.projectId,
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

    // Attempt to capture final token usage and session info from the worker
    // state API before the worker process fully exits.
    const workerInfo = await this.fetchWorkerRunInfo(run);
    const runWithTokens: OrchestratorRunRecord = {
      ...run,
      runtimeSession: buildRuntimeSession(
        run.runtimeSession,
        workerInfo.sessionId,
        workerInfo.threadId,
        run.status === "running" ? "failed" : run.runtimeSession?.status ?? null,
        run.runtimeSession?.startedAt ?? run.startedAt ?? now.toISOString(),
        now.toISOString()
      ),
      tokenUsage: workerInfo.tokenUsage ?? run.tokenUsage,
      lastEvent: workerInfo.lastEvent ?? run.lastEvent,
      lastEventAt: workerInfo.lastEventAt ?? run.lastEventAt,
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

      return this.restartRun(
        tenant,
        run,
        issueRecords,
        now,
        workerSessionId
      );
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

    // Determine retry kind: continuation (issue still actionable) vs failure
    const retryKind = await this.classifyRetryKind(tenant, run);

    let nextRetryAt: string;
    if (retryKind === "continuation") {
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
      retryKind,
      runPhase: runWithTokens.runPhase ?? "failed",
      lastError:
        retryKind === "continuation"
          ? null
          : "Worker process exited unexpectedly.",
    };
    await this.store.saveRun(retryRecord);
    this.logVerbose(
      `[retry-scheduled] ${retryRecord.runId} kind=${retryKind} attempt=${retryRecord.attempt} nextAt=${nextRetryAt}`
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
            projectId: tenant.projectId,
            adapter: tenant.tracker.adapter,
            issueSubjectId: run.issueSubjectId,
          },
          run.issueIdentifier
        ),
      state: "retry_queued",
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

  private logVerbose(message: string): void {
    if (!this.isVerboseLoggingEnabled()) {
      return;
    }
    this.writeStderr(message);
  }

  private async waitForNextPoll(): Promise<void> {
    const customWait = this.dependencies.waitImpl;
    if (customWait) {
      await customWait(this.getEffectivePollIntervalMs());
      return;
    }

    await new Promise<void>((resolve) => {
      this.sleepResolver = () => {
        this.sleepResolver = null;
        this.sleepTimer = null;
        resolve();
      };
      this.sleepTimer = setTimeout(
        this.sleepResolver,
        this.getEffectivePollIntervalMs()
      );
    });
  }

  private cancelPendingSleep(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver?.();
    this.sleepResolver = null;
  }

  private async allocatePort(): Promise<number> {
    // Skip ports that are still in use by lingering worker processes
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      this.nextPort += 1;
      if (await isPortAvailable(this.nextPort)) {
        return this.nextPort;
      }
    }
    // Fallback: return next port even if availability check exhausted
    this.nextPort += 1;
    return this.nextPort;
  }

  private initializePortFrom(runs: OrchestratorRunRecord[]): void {
    const maxPort = runs.reduce(
      (max, run) => Math.max(max, run.port ?? 0),
      DEFAULT_PORT_BASE
    );
    if (maxPort > this.nextPort) {
      this.nextPort = maxPort;
    }
  }

  /**
   * Classify whether a process exit should be treated as continuation retry
   * or failure retry. Continuation applies when the issue is still actionable
   * — the worker completed its session and the issue hasn't transitioned away.
   * Failure applies when we cannot confirm the issue is still actionable.
   */
  private async classifyRetryKind(
    tenant: OrchestratorProjectConfig,
    run: OrchestratorRunRecord
  ): Promise<"continuation" | "failure"> {
    try {
      const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
      const issues = await trackerAdapter.listIssues(tenant, {
        fetchImpl: this.dependencies.fetchImpl,
      });
      const runIssue = issues.find(
        (issue: TrackedIssue) => issue.identifier === run.issueIdentifier
      );
      if (!runIssue) {
        return "failure";
      }
      const resolution = await this.loadProjectWorkflow(tenant, run.repository);
      if (!isUsableWorkflowResolution(resolution)) {
        return "failure";
      }
      return isStateActive(runIssue.state, resolution.lifecycle)
        ? "continuation"
        : "failure";
    } catch {
      return "failure";
    }
  }

  /**
   * Attempt to fetch final token usage from the worker state API.
   * Returns the token usage object or null if the worker is unreachable.
   */
  private async fetchWorkerRunInfo(run: OrchestratorRunRecord): Promise<{
    tokenUsage: OrchestratorRunRecord["tokenUsage"] | null;
    sessionId: string | null;
    threadId: string | null;
    turnCount: number | null;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
    executionPhase: OrchestratorRunRecord["executionPhase"];
    runPhase: OrchestratorRunRecord["runPhase"];
    rateLimits: Record<string, unknown> | null;
  }> {
    const liveState = await this.fetchLiveWorkerState(run);
    if (liveState.tokenUsage) {
      return liveState;
    }

    const persistedTokenUsage = await this.readPersistedWorkerTokenUsage(run);
    return {
      tokenUsage: persistedTokenUsage,
      sessionId: liveState.sessionId,
      threadId: liveState.threadId,
      turnCount: liveState.turnCount,
      lastError: liveState.lastError,
      lastEvent: liveState.lastEvent,
      lastEventAt: liveState.lastEventAt,
      executionPhase: liveState.executionPhase,
      runPhase: liveState.runPhase,
      rateLimits: liveState.rateLimits,
    };
  }

  private async fetchLiveWorkerState(run: OrchestratorRunRecord): Promise<{
    tokenUsage: OrchestratorRunRecord["tokenUsage"] | null;
    sessionId: string | null;
    threadId: string | null;
    turnCount: number | null;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
    executionPhase: OrchestratorRunRecord["executionPhase"];
    runPhase: OrchestratorRunRecord["runPhase"];
    rateLimits: Record<string, unknown> | null;
  }> {
    if (!run.port) {
      return {
        tokenUsage: null,
        sessionId: null,
        threadId: null,
        turnCount: null,
        lastError: null,
        lastEvent: null,
        lastEventAt: null,
        executionPhase: null,
        runPhase: null,
        rateLimits: null,
      };
    }

    try {
      const fetchImpl = this.dependencies.fetchImpl ?? fetch;
      const response = await fetchImpl(
        `http://127.0.0.1:${run.port}/api/v1/state`,
        { signal: AbortSignal.timeout(2000) }
      );
      if (!response.ok) {
        return {
          tokenUsage: null,
          sessionId: null,
          threadId: null,
          turnCount: null,
          lastError: null,
          lastEvent: null,
          lastEventAt: null,
          executionPhase: null,
          runPhase: null,
          rateLimits: null,
        };
      }

      const state = (await response.json()) as {
        status?: string;
        executionPhase?: unknown;
        runPhase?: unknown;
        sessionId?: unknown;
        tokenUsage?: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        };
        sessionInfo?: {
          threadId: string | null;
          turnId?: string | null;
          turnCount: number;
          sessionId?: string | null;
        } | null;
        run?: { lastError: string | null } | null;
        rateLimits?: Record<string, unknown> | null;
      };

      const tokenUsage = hasTokenUsage(state.tokenUsage)
        ? state.tokenUsage
        : null;
      const topLevelSessionId = asStringOrNull(state.sessionId);
      const nestedSessionId = asStringOrNull(state.sessionInfo?.sessionId);
      const threadId = asStringOrNull(state.sessionInfo?.threadId);
      const turnId = asStringOrNull(state.sessionInfo?.turnId);
      const sessionId =
        topLevelSessionId ??
        nestedSessionId ??
        (threadId && turnId
          ? `${threadId}-${turnId}`
          : null);
      const turnCount =
        typeof state.sessionInfo?.turnCount === "number"
          ? state.sessionInfo.turnCount
          : null;
      const lastError =
        typeof state.run?.lastError === "string" ? state.run.lastError : null;
      const lastEvent = state.status ?? null;
      const lastEventAt: string | null = null; // worker doesn't emit event timestamps
      const executionPhase = parseExecutionPhase(state.executionPhase);
      const runPhase = parseRunPhase(state.runPhase);
      const rateLimits = isRecord(state.rateLimits) ? state.rateLimits : null;

      return {
        tokenUsage,
        sessionId,
        threadId,
        turnCount,
        lastError,
        lastEvent,
        lastEventAt,
        executionPhase,
        runPhase,
        rateLimits,
      };
    } catch {
      return {
        tokenUsage: null,
        sessionId: null,
        threadId: null,
        turnCount: null,
        lastError: null,
        lastEvent: null,
        lastEventAt: null,
        executionPhase: null,
        runPhase: null,
        rateLimits: null,
      };
    }
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
        (entry): entry is [string, string] => typeof entry[1] === "string"
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
    // and isActiveRunStatus() picks it up on every tick, calling restartRun()
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
    const restarted = await this.startRun(tenant, issue);
    const recoveredRecord: OrchestratorRunRecord = {
      ...restarted,
      attempt: run.attempt,
      retryKind: run.retryKind ?? "recovery",
      createdAt: run.createdAt,
      issueWorkspaceKey: run.issueWorkspaceKey,
    };
    await this.store.saveRun(recoveredRecord);
    await this.store.appendRunEvent(run.runId, {
      at: now.toISOString(),
      event: "run-recovered",
      projectId: run.projectId,
      issueIdentifier: run.issueIdentifier,
      issueId: run.issueId,
      sessionId: sessionId ?? undefined,
    } as OrchestratorEvent);

    return {
      issueRecords: upsertIssueOrchestration(issueRecords, {
        issueId: recoveredRecord.issueId,
        identifier: recoveredRecord.issueIdentifier,
        workspaceKey:
          recoveredRecord.issueWorkspaceKey ??
          deriveIssueWorkspaceKey(
            {
              projectId: tenant.projectId,
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

  private async loadProjectPollInterval(
    tenant: OrchestratorProjectConfig
  ): Promise<number> {
    const intervals = await Promise.all(
      tenant.repositories.map(async (repository) => {
        const resolution = await this.loadProjectWorkflow(tenant, repository);
        return isUsableWorkflowResolution(resolution)
          ? resolution.workflow.polling.intervalMs
          : NaN;
      })
    );
    const validIntervals = intervals.filter(
      (value) => Number.isFinite(value) && value > 0
    );
    return validIntervals.length
      ? Math.min(...validIntervals)
      : DEFAULT_POLL_INTERVAL_MS;
  }

  private async loadProjectMaxConcurrentByState(
    tenant: OrchestratorProjectConfig
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const resolutions = await Promise.all(
      tenant.repositories.map(async (repository) => {
        try {
          return await this.loadProjectWorkflow(tenant, repository);
        } catch {
          return null;
        }
      })
    );

    for (const resolution of resolutions) {
      if (!resolution) continue;
      if (!isUsableWorkflowResolution(resolution)) continue;
      const stateLimits = resolution.workflow.agent.maxConcurrentAgentsByState;
      for (const [state, limit] of Object.entries(stateLimits)) {
        const existing = result[state];
        const numLimit = typeof limit === "number" ? limit : Number(limit);
        // Use the minimum limit across all repository workflows
        result[state] =
          existing === undefined ? numLimit : Math.min(existing, numLimit);
      }
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
        stallTimeoutMs: resolution.workflow.codex.stallTimeoutMs,
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

    const limits = await Promise.all(
      project.repositories.map(async (repository) => {
        try {
          const resolution = await this.loadProjectWorkflow(project, repository);
          return isUsableWorkflowResolution(resolution)
            ? resolution.workflow.agent.maxConcurrentAgents
            : NaN;
        } catch {
          return NaN;
        }
      })
    );
    const validLimits = limits.filter(
      (value) => Number.isFinite(value) && value >= 0
    );
    return validLimits.length ? Math.min(...validLimits) : DEFAULT_CONCURRENCY;
  }

  private async resolveWorkflowResolution(
    repository: RepositoryRef,
    cacheRoot: string,
    resolution: WorkflowResolution,
    changed: boolean
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
          (await this.persistLastKnownGoodWorkflow(cacheRoot, effectiveResolution)) ??
          effectiveResolution.workflowPath;
      } catch {
        workflowPath = effectiveResolution.workflowPath;
      }
      this.lastKnownGoodWorkflows.set(cacheKey, {
        ...effectiveResolution,
        workflowPath,
      });
      this.lastReportedWorkflowErrors.delete(cacheKey);
      return effectiveResolution;
    }

    const cached = this.lastKnownGoodWorkflows.get(cacheKey);
    const message = resolution.validationError ?? "Invalid repository WORKFLOW.md";
    const previousMessage = this.lastReportedWorkflowErrors.get(cacheKey);
    if (changed || previousMessage !== message) {
      process.stderr.write(
        `[orchestrator] failed to reload WORKFLOW.md for ${repository.owner}/${repository.name}: ${message}\n`
      );
      this.lastReportedWorkflowErrors.set(cacheKey, message);
    }

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
    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      projectId: tenant.projectId,
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const preferredWorkspaceKey = deriveIssueWorkspaceKey(
      identity,
      issue.identifier
    );
    const legacyWorkspaceKey = deriveLegacyIssueWorkspaceKey(identity);
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
      (await this.store.loadIssueWorkspace(tenant.projectId, preferredWorkspaceKey)) ??
      (legacyWorkspaceKey === preferredWorkspaceKey
        ? null
        : await this.store.loadIssueWorkspace(tenant.projectId, legacyWorkspaceKey));

    if (
      !workspaceRecord ||
      workspaceRecord.status === "removed" ||
      workspaceRecord.status === "cleanup_blocked"
    ) {
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

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveProjectRateLimits(
  runs: Iterable<OrchestratorRunRecord>,
  issues: Iterable<TrackedIssue>
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

  return null;
}

function buildRuntimeSession(
  existing: OrchestratorRunRecord["runtimeSession"] | null | undefined,
  sessionId: string | null,
  threadId: string | null,
  status: RuntimeSessionRow["status"],
  startedAt: string | null,
  updatedAt: string
): OrchestratorRunRecord["runtimeSession"] | undefined {
  if (
    existing === undefined &&
    sessionId === null &&
    threadId === null &&
    status === null
  ) {
    return undefined;
  }

  return {
    sessionId: sessionId ?? existing?.sessionId ?? null,
    threadId: threadId ?? existing?.threadId ?? null,
    status: status ?? existing?.status ?? null,
    startedAt: existing?.startedAt ?? startedAt,
    updatedAt,
    exitClassification: existing?.exitClassification ?? null,
  };
}

function resolveWorkerCommand(): string {
  if (process.env.SYMPHONY_WORKER_COMMAND) {
    return process.env.SYMPHONY_WORKER_COMMAND;
  }
  try {
    const workerUrl = import.meta.resolve("@gh-symphony/worker");
    return `node ${fileURLToPath(workerUrl)}`;
  } catch {
    return DEFAULT_WORKER_COMMAND;
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

function isIssueOrchestrationClaimed(
  state: IssueOrchestrationRecord["state"]
): boolean {
  return state === "claimed" || state === "running" || state === "retry_queued";
}

function upsertIssueOrchestration(
  issueRecords: IssueOrchestrationRecord[],
  nextRecord: IssueOrchestrationRecord
): IssueOrchestrationRecord[] {
  const remaining = issueRecords.filter(
    (record) => record.issueId !== nextRecord.issueId
  );
  return [...remaining, nextRecord];
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

function isActiveRunStatus(status: OrchestratorRunRecord["status"]): boolean {
  return (
    status === "pending" ||
    status === "starting" ||
    status === "running" ||
    status === "retrying"
  );
}

function mapIssueOrchestrationStateToStatus(
  state: IssueOrchestrationRecord["state"]
): string {
  switch (state) {
    case "claimed":
      return "starting";
    case "running":
      return "running";
    case "retry_queued":
      return "retrying";
    case "released":
      return "released";
    case "unclaimed":
      return "pending";
    default:
      return state;
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });
}

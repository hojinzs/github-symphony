import { readFile, rm } from "node:fs/promises";
import { mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
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
  renderPrompt,
  resolveIssueWorkspaceDirectory,
  scheduleRetryAt,
  type HookResult,
  type IssueOrchestrationRecord,
  type IssueStatusSnapshot,
  type IssueSubjectIdentity,
  type IssueWorkspaceRecord,
  type OrchestratorRunRecord,
  type OrchestratorStateStore,
  type OrchestratorProjectConfig,
  type ProjectStatusSnapshot,
  type RepositoryRef,
  type RunAttemptPhase,
  type TrackedIssue,
  type WorkflowLifecycleConfig,
} from "@gh-symphony/core";
import {
  cloneRepositoryForRun,
  ensureIssueWorkspaceRepository,
  loadRepositoryWorkflow,
} from "./git.js";
import { OrchestratorFsStore } from "./fs-store.js";
import { resolveTrackerAdapter } from "./tracker-adapters.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_PORT_BASE = 4600;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WORKER_COMMAND = "node packages/worker/dist/index.js";

type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

function parseExecutionPhase(value: unknown) {
  return isWorkflowExecutionPhase(value) ? value : null;
}

function parseRunPhase(value: unknown): RunAttemptPhase | null {
  return isRunAttemptPhase(value) ? value : null;
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

export class OrchestratorService {
  private nextPort = DEFAULT_PORT_BASE;
  private readonly projectPollIntervals = new Map<string, number>();

  constructor(
    readonly store: OrchestratorStateStore,
    readonly projectConfig: OrchestratorProjectConfig,
    readonly dependencies: {
      fetchImpl?: typeof fetch;
      spawnImpl?: SpawnLike;
      now?: () => Date;
      concurrency?: number;
      pollIntervalMs?: number;
      maxAttempts?: number;
      retryBackoffMs?: number;
    } = {}
  ) {}

  async run(
    options: {
      issueIdentifier?: string;
      once?: boolean;
    } = {}
  ): Promise<void> {
    for (;;) {
      await this.runOnce(options);

      if (options.once) {
        return;
      }

      await wait(this.getEffectivePollIntervalMs());
    }
  }

  async runOnce(
    options: {
      issueIdentifier?: string;
    } = {}
  ): Promise<ProjectStatusSnapshot> {
    return this.reconcileProject(this.projectConfig, options.issueIdentifier);
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
      ? await this.store.loadRun(issueRecord.currentRunId)
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
        : await this.store.loadRecentRunEvents(currentRun.runId);
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
                  path: join(this.store.runDir(currentRun.runId), "worker.log"),
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
    issueIdentifier?: string
  ): Promise<ProjectStatusSnapshot> {
    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const now = this.now();
    let lastError: string | null = null;
    let dispatched = 0;
    let suppressed = 0;
    let recovered = 0;
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

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

    try {
      pollIntervalMs = await this.loadProjectPollInterval(tenant);
      const issues = await trackerAdapter.listIssues(tenant, {
        fetchImpl: this.dependencies.fetchImpl,
      });
      const currentActiveRuns = (await this.store.loadAllRuns()).filter(
        (run) =>
          run.projectId === tenant.projectId && isActiveRunStatus(run.status)
      );
      const syncedActiveRuns = await this.syncActiveRunIssueStates(
        currentActiveRuns,
        issues,
        now
      );
      const filteredIssues = issueIdentifier
        ? issues.filter(
            (issue: TrackedIssue) => issue.identifier === issueIdentifier
          )
        : issues;
      const { candidates: actionableCandidates, lifecycle } =
        await this.resolveActionableCandidates(tenant, filteredIssues);
      const concurrency = this.getProjectConcurrency(tenant);
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
        dispatched += 1;
        slotsRemaining -= 1;
        activeByState.set(
          issue.state,
          (activeByState.get(issue.state) ?? 0) + 1
        );
      }

      for (const issue of filteredIssues) {
        const issueRecord = issueRecords.find(
          (entry) =>
            entry.issueId === issue.id &&
            isIssueOrchestrationClaimed(entry.state)
        );
        if (!issueRecord) {
          continue;
        }

        const resolvedIssue = actionableCandidates.find(
          (candidate) => candidate.identifier === issue.identifier
        );
        if (!resolvedIssue) {
          const leasedRun = issueRecord.currentRunId
            ? await this.store.loadRun(issueRecord.currentRunId)
            : null;
          if (leasedRun?.processId) {
            try {
              process.kill(leasedRun.processId, "SIGTERM");
            } catch {
              // Ignore already-exited workers during suppression.
            }
          }
          if (leasedRun) {
            await this.store.saveRun({
              ...leasedRun,
              status: "suppressed",
              completedAt: now.toISOString(),
              updatedAt: now.toISOString(),
              runPhase: "canceled_by_reconciliation",
              lastError:
                "Run suppressed because the tracker state is no longer actionable.",
            });
          }
          issueRecords = releaseIssueOrchestration(
            issueRecords,
            issue.id,
            now
          );
          suppressed += 1;
        }
      }

      // Clean up issue workspaces for terminal issues
      for (const issue of filteredIssues) {
        if (!isStateTerminal(issue.state, lifecycle)) {
          continue;
        }
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
    const status = buildProjectSnapshot({
      project: tenant,
      activeRuns: latestRuns,
      allRuns: allTenantRuns,
      summary: { dispatched, suppressed, recovered },
      lastTickAt: now.toISOString(),
      lastError,
    });
    await this.store.saveProjectStatus(status);
    return status;
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
      if (!resolution.isValid) {
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
        const hasNonTerminalBlocker = issue.blockedBy.some(
          (blockerId: string) => {
            const blockerIssue = issues.find((i) => i.identifier === blockerId);
            if (!blockerIssue) return true; // Unknown blocker treated as blocking
            return !isStateTerminal(blockerIssue.state, resolution.lifecycle);
          }
        );
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
      if (resolution.isValid) {
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
  ) {
    const cacheRoot = join(
      tenant.workspaceDir,
      "workflow-cache",
      repository.owner,
      repository.name
    );
    const repositoryDirectory = await cloneRepositoryForRun({
      repository,
      targetDirectory: cacheRoot,
    });

    return await loadRepositoryWorkflow(repositoryDirectory, repository);
  }

  private async startRun(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue
  ): Promise<OrchestratorRunRecord> {
    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const now = this.now();
    const runId = createRunId(now, tenant.projectId, issue.identifier);
    const runDir = this.store.runDir(runId);
    const workspaceRuntimeDir = join(runDir, "workspace-runtime");

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
    const issueWorkspacePath = resolveIssueWorkspaceDirectory(
      tenant.workspaceDir,
      tenant.projectId,
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
          hook: "after_create",
          error: afterCreateResult.error ?? null,
        });
      }
    }

    const workflow = await this.loadProjectWorkflow(tenant, issue.repository);
    if (!workflow.isValid) {
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
        env: {
          ...process.env,
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
          SYMPHONY_AGENT_COMMAND: workflow.workflow.codex.command,
          SYMPHONY_MAX_TURNS: String(workflow.workflow.agent.maxTurns),
          SYMPHONY_READ_TIMEOUT_MS: String(
            workflow.workflow.codex.readTimeoutMs
          ),
          SYMPHONY_TURN_TIMEOUT_MS: String(
            workflow.workflow.codex.turnTimeoutMs
          ),
        },
        detached: true,
        stdio: ["ignore", "ignore", workerLogFd],
      }
    );

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
    };
  }

  private async syncActiveRunIssueStates(
    activeRuns: OrchestratorRunRecord[],
    issues: TrackedIssue[],
    now: Date
  ): Promise<OrchestratorRunRecord[]> {
    const issueStateByIdentifier = new Map(
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

    return syncedRuns;
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

    if (run.processId && isProcessRunning(run.processId)) {
      // Stuck worker detection: if the run has been active for longer than
      // the timeout without the worker exiting on its own, kill it so
      // the orchestrator can re-dispatch (continuation retry).
      const STUCK_WORKER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : 0;
      const runningSince = now.getTime() - startedAt;
      if (runningSince > STUCK_WORKER_TIMEOUT_MS) {
        process.stderr.write(
          `[orchestrator] stuck worker detected for ${run.runId} (running ${Math.round(runningSince / 60000)}min) — sending SIGTERM\n`
        );
        try {
          process.kill(run.processId, "SIGTERM");
        } catch {
          // Already gone.
        }
        // Fall through: treat as a normal exit and retry.
      } else {
        const liveState = await this.fetchLiveWorkerState(run);
        const runningRecord: OrchestratorRunRecord = {
          ...run,
          status: "running",
          updatedAt: now.toISOString(),
          turnCount: liveState.turnCount ?? undefined,
          tokenUsage: liveState.tokenUsage ?? run.tokenUsage,
          lastEvent: liveState.lastEvent ?? undefined,
          lastEventAt: liveState.lastEventAt ?? undefined,
          executionPhase: liveState.executionPhase ?? run.executionPhase ?? null,
          runPhase: liveState.runPhase ?? run.runPhase ?? "streaming_turn",
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

    // Attempt to capture final token usage and session info from the worker
    // state API before the worker process fully exits.
    const workerInfo = await this.fetchWorkerRunInfo(run);
    const runWithTokens: OrchestratorRunRecord = {
      ...run,
      tokenUsage: workerInfo.tokenUsage ?? run.tokenUsage,
      lastEvent: workerInfo.lastEvent ?? run.lastEvent,
      lastEventAt: workerInfo.lastEventAt ?? run.lastEventAt,
      executionPhase: workerInfo.executionPhase ?? run.executionPhase ?? null,
      runPhase: workerInfo.runPhase ?? run.runPhase ?? null,
    };
    const workerSessionId = workerInfo.sessionId;

    if (workerInfo.lastError) {
      await this.store.appendRunEvent(run.runId, {
        at: now.toISOString(),
        event: "worker-error",
        runId: run.runId,
        issueIdentifier: run.issueIdentifier,
        error: workerInfo.lastError,
        attempt: run.attempt,
      });
    }

    if (run.attempt >= this.getProjectMaxAttempts(tenant)) {
      const failedRecord: OrchestratorRunRecord = {
        ...runWithTokens,
        status: "failed",
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        retryKind: runWithTokens.retryKind ?? "failure",
        runPhase: runWithTokens.runPhase ?? "failed",
        lastError:
          runWithTokens.lastError ?? "Worker process exited unexpectedly.",
      };
      await this.store.saveRun(failedRecord);
      return {
        issueRecords: releaseIssueOrchestration(issueRecords, run.issueId, now),
        recovered: false,
      };
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
        tenant.workspaceDir,
        tenant.projectId,
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
    const retryOptions = await this.loadRetryPolicy(tenant, run.repository);

    let nextRetryAt: string;
    if (retryKind === "continuation") {
      // Short delay for continuation — recheck issue eligibility promptly
      const continuationDelay =
        retryOptions?.baseDelayMs ?? DEFAULT_RETRY_BACKOFF_MS;
      nextRetryAt = new Date(now.getTime() + continuationDelay).toISOString();
    } else {
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
      if (!resolution.isValid) {
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
    turnCount: number | null;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
    executionPhase: OrchestratorRunRecord["executionPhase"];
    runPhase: OrchestratorRunRecord["runPhase"];
  }> {
    const liveState = await this.fetchLiveWorkerState(run);
    if (liveState.tokenUsage) {
      return liveState;
    }

    const persistedTokenUsage = await this.readPersistedWorkerTokenUsage(run);
    return {
      tokenUsage: persistedTokenUsage,
      sessionId: liveState.sessionId,
      turnCount: liveState.turnCount,
      lastError: liveState.lastError,
      lastEvent: liveState.lastEvent,
      lastEventAt: liveState.lastEventAt,
      executionPhase: liveState.executionPhase,
      runPhase: liveState.runPhase,
    };
  }

  private async fetchLiveWorkerState(run: OrchestratorRunRecord): Promise<{
    tokenUsage: OrchestratorRunRecord["tokenUsage"] | null;
    sessionId: string | null;
    turnCount: number | null;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
    executionPhase: OrchestratorRunRecord["executionPhase"];
    runPhase: OrchestratorRunRecord["runPhase"];
  }> {
    if (!run.port) {
      return {
        tokenUsage: null,
        sessionId: null,
        turnCount: null,
        lastError: null,
        lastEvent: null,
        lastEventAt: null,
        executionPhase: null,
        runPhase: null,
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
          turnCount: null,
          lastError: null,
          lastEvent: null,
          lastEventAt: null,
          executionPhase: null,
          runPhase: null,
        };
      }

      const state = (await response.json()) as {
        status?: string;
        executionPhase?: unknown;
        runPhase?: unknown;
        tokenUsage?: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        };
        sessionInfo?: {
          threadId: string | null;
          turnCount: number;
        } | null;
        run?: { lastError: string | null } | null;
      };

      const tokenUsage = hasTokenUsage(state.tokenUsage)
        ? state.tokenUsage
        : null;
      const sessionId =
        state.sessionInfo?.threadId && state.sessionInfo.turnCount > 0
          ? `${state.sessionInfo.threadId}-${state.sessionInfo.turnCount}`
          : null;
      const turnCount = state.sessionInfo?.turnCount ?? null;
      const lastError = state.run?.lastError ?? null;
      const lastEvent = state.status ?? null;
      const lastEventAt: string | null = null; // worker doesn't emit event timestamps
      const executionPhase = parseExecutionPhase(state.executionPhase);
      const runPhase = parseRunPhase(state.runPhase);

      return {
        tokenUsage,
        sessionId,
        turnCount,
        lastError,
        lastEvent,
        lastEventAt,
        executionPhase,
        runPhase,
      };
    } catch {
      return {
        tokenUsage: null,
        sessionId: null,
        turnCount: null,
        lastError: null,
        lastEvent: null,
        lastEventAt: null,
        executionPhase: null,
        runPhase: null,
      };
    }
  }

  private async readPersistedWorkerTokenUsage(
    run: OrchestratorRunRecord
  ): Promise<OrchestratorRunRecord["tokenUsage"] | null> {
    const artifactPath = join(
      run.workspaceRuntimeDir,
      ".orchestrator",
      "runs",
      run.runId,
      "token-usage.json"
    );

    try {
      const raw = await readFile(artifactPath, "utf8");
      const tokenUsage = JSON.parse(raw) as OrchestratorRunRecord["tokenUsage"];
      return hasTokenUsage(tokenUsage) ? tokenUsage : null;
    } catch {
      return null;
    }
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
    }
  ): Promise<HookResult | null> {
    try {
      const resolution = await this.loadProjectWorkflow(tenant, repository);
      if (!resolution.isValid) {
        return null;
      }
      const hookEnv = buildHookEnv(context);
      return executeWorkspaceHook({
        kind,
        hooks: resolution.workflow.hooks,
        repositoryPath: repositoryDirectory,
        env: hookEnv,
        timeoutMs: resolution.workflow.hooks.timeoutMs,
      });
    } catch {
      // If workflow cannot be loaded, skip hook execution
      return null;
    }
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
      issueIdentifier: run.issueIdentifier,
      issueId: run.issueId,
      sessionId: sessionId ?? undefined,
    });

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
        return resolution.isValid
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
      if (!resolution.isValid) continue;
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
  ): Promise<{ baseDelayMs: number; maxDelayMs: number } | null> {
    if (this.dependencies.retryBackoffMs) {
      return {
        baseDelayMs: this.dependencies.retryBackoffMs,
        maxDelayMs: this.dependencies.retryBackoffMs,
      };
    }

    try {
      const resolution = await this.loadProjectWorkflow(tenant, repository);
      if (!resolution.isValid) {
        return null;
      }
      return {
        baseDelayMs: resolution.workflow.agent.retryBaseDelayMs,
        maxDelayMs: resolution.workflow.agent.maxRetryBackoffMs,
      };
    } catch {
      return null;
    }
  }

  private getProjectConcurrency(_project: OrchestratorProjectConfig): number {
    return this.dependencies.concurrency ?? DEFAULT_CONCURRENCY;
  }

  private getProjectMaxAttempts(_project: OrchestratorProjectConfig): number {
    return this.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Clean up the issue workspace for a terminal issue.
   *
   * Runs the `before_remove` hook if configured. If the hook fails,
   * the workspace transitions to `cleanup_blocked` (fail-closed per design
   * decision 12). If it succeeds, the workspace directory is removed and
   * the record set to `removed`. Orchestration records (runs) are preserved.
   */
  private async cleanupTerminalIssueWorkspace(
    tenant: OrchestratorProjectConfig,
    issue: TrackedIssue,
    now: Date
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

    // Run before_remove hook (fail-closed)
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
      }
    );

    if (
      hookResult &&
      hookResult.outcome !== "success" &&
      hookResult.outcome !== "skipped"
    ) {
      // Fail closed: block cleanup, require operator intervention
      const blockedRecord: IssueWorkspaceRecord = {
        ...workspaceRecord,
        status: "cleanup_blocked",
        updatedAt: now.toISOString(),
        lastError:
          hookResult.error ?? `before_remove hook ${hookResult.outcome}`,
      };
      await this.store.saveIssueWorkspace(blockedRecord);
      return;
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

function resolveWorkerCommand(): string {
  try {
    const workerUrl = import.meta.resolve("@gh-symphony/worker/dist/index.js");
    return `node ${fileURLToPath(workerUrl)}`;
  } catch {
    return DEFAULT_WORKER_COMMAND;
  }
}

export function createStore(runtimeRoot = ".runtime") {
  return new OrchestratorFsStore(runtimeRoot);
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

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
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

import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";
import {
  buildHookEnv,
  buildPromptVariables,
  buildWorkspaceSnapshot,
  deriveIssueWorkspaceKey,
  executeWorkspaceHook,
  isWorkflowPhaseActionable,
  isWorkflowPhaseTerminal,
  renderPrompt,
  resolveIssueWorkspaceDirectory,
  resolveWorkflowExecutionPhase,
  scheduleRetryAt,
  type HookResult,
  type IssueSubjectIdentity,
  type IssueWorkspaceRecord,
  type OrchestratorRunRecord,
  type OrchestratorStateStore,
  type OrchestratorWorkspaceConfig,
  type RepositoryRef,
  type TrackedIssue,
  type WorkspaceLeaseRecord,
  type WorkspaceStatusSnapshot,
} from "@github-symphony/core";
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

export class OrchestratorService {
  private nextPort = DEFAULT_PORT_BASE;
  private readonly workspacePollIntervals = new Map<string, number>();

  constructor(
    readonly store: OrchestratorStateStore,
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
      workspaceId?: string;
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
      workspaceId?: string;
      issueIdentifier?: string;
    } = {}
  ): Promise<WorkspaceStatusSnapshot[]> {
    const workspaces = await this.loadTargetWorkspaces(options.workspaceId);
    const snapshots: WorkspaceStatusSnapshot[] = [];

    for (const workspace of workspaces) {
      snapshots.push(
        await this.reconcileWorkspace(workspace, options.issueIdentifier)
      );
    }

    return snapshots;
  }

  async status(workspaceId?: string): Promise<WorkspaceStatusSnapshot[]> {
    const workspaces = await this.loadTargetWorkspaces(workspaceId);
    const statuses = await Promise.all(
      workspaces.map((workspace) =>
        this.store.loadWorkspaceStatus(workspace.workspaceId)
      )
    );

    return statuses.filter((status): status is WorkspaceStatusSnapshot =>
      Boolean(status)
    );
  }

  async recover(workspaceId?: string): Promise<WorkspaceStatusSnapshot[]> {
    return this.runOnce({
      workspaceId,
    });
  }

  getEffectivePollIntervalMs(): number {
    if (this.dependencies.pollIntervalMs) {
      return this.dependencies.pollIntervalMs;
    }

    const configuredIntervals = [
      ...this.workspacePollIntervals.values(),
    ].filter((value) => Number.isFinite(value) && value > 0);
    return configuredIntervals.length
      ? Math.min(...configuredIntervals)
      : DEFAULT_POLL_INTERVAL_MS;
  }

  private async loadTargetWorkspaces(
    workspaceId?: string
  ): Promise<OrchestratorWorkspaceConfig[]> {
    const workspaces = await this.store.loadWorkspaceConfigs();
    return workspaceId
      ? workspaces.filter((workspace) => workspace.workspaceId === workspaceId)
      : workspaces;
  }

  private async reconcileWorkspace(
    workspace: OrchestratorWorkspaceConfig,
    issueIdentifier?: string
  ): Promise<WorkspaceStatusSnapshot> {
    const trackerAdapter = resolveTrackerAdapter(workspace.tracker);
    const now = this.now();
    let lastError: string | null = null;
    let dispatched = 0;
    let suppressed = 0;
    let recovered = 0;
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

    let leases = await this.store.loadWorkspaceLeases(workspace.workspaceId);
    const allRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.workspaceId === workspace.workspaceId
    );
    const activeRuns = allRuns.filter((run) => isActiveRunStatus(run.status));
    this.initializePortFrom(allRuns);

    for (const run of activeRuns) {
      const outcome = await this.reconcileRun(workspace, run, leases);
      leases = outcome.leases;
      if (outcome.recovered) {
        recovered += 1;
      }
    }

    try {
      pollIntervalMs = await this.loadWorkspacePollInterval(workspace);
      const issues = await trackerAdapter.listIssues(workspace, {
        fetchImpl: this.dependencies.fetchImpl,
      });
      const filteredIssues = issueIdentifier
        ? issues.filter((issue) => issue.identifier === issueIdentifier)
        : issues;
      const actionableCandidates = await this.resolveActionableCandidates(
        workspace,
        filteredIssues
      );
      const concurrency = this.dependencies.concurrency ?? DEFAULT_CONCURRENCY;
      const currentlyActive = leases.filter(
        (lease) => lease.status === "active"
      ).length;
      const availableSlots = Math.max(0, concurrency - currentlyActive);

      const unscheduledCandidates = actionableCandidates.filter((issue) => {
        const leaseKey = buildLeaseKey(issue);
        return !leases.some(
          (lease) => lease.leaseKey === leaseKey && lease.status === "active"
        );
      });

      for (const issue of unscheduledCandidates.slice(0, availableSlots)) {
        const leaseKey = buildLeaseKey(issue);
        const run = await this.startRun(workspace, issue);
        leases = upsertLease(leases, {
          leaseKey,
          runId: run.runId,
          issueId: run.issueId,
          issueIdentifier: run.issueIdentifier,
          phase: run.phase,
          status: "active",
          updatedAt: now.toISOString(),
        });
        await this.store.saveRun(run);
        await this.store.appendRunEvent(run.runId, {
          at: now.toISOString(),
          event: "run-dispatched",
          workspaceId: workspace.workspaceId,
          issueIdentifier: issue.identifier,
          phase: issue.phase,
        });
        dispatched += 1;
      }

      for (const issue of filteredIssues) {
        const leaseKey = buildLeaseKey(issue);
        const lease = leases.find(
          (entry) => entry.leaseKey === leaseKey && entry.status === "active"
        );
        if (!lease) {
          continue;
        }

        const resolvedIssue = actionableCandidates.find(
          (candidate) => candidate.identifier === issue.identifier
        );
        if (!resolvedIssue) {
          const leasedRun = await this.store.loadRun(lease.runId);
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
              lastError:
                "Run suppressed because the tracker state is no longer actionable.",
            });
          }
          leases = releaseLease(leases, leaseKey, now);
          suppressed += 1;
        }
      }

      // Clean up issue workspaces for terminal (completed) issues
      for (const issue of filteredIssues) {
        if (!isWorkflowPhaseTerminal(issue.phase)) {
          continue;
        }
        await this.cleanupTerminalIssueWorkspace(workspace, issue, now);
      }
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "Unknown orchestration error";
    }

    this.workspacePollIntervals.set(workspace.workspaceId, pollIntervalMs);
    await this.store.saveWorkspaceLeases(workspace.workspaceId, leases);

    const latestRuns = (await this.store.loadAllRuns()).filter(
      (run) =>
        run.workspaceId === workspace.workspaceId &&
        isActiveRunStatus(run.status)
    );
    const status = buildWorkspaceSnapshot({
      workspace,
      activeRuns: latestRuns,
      summary: { dispatched, suppressed, recovered },
      lastTickAt: now.toISOString(),
      lastError,
    });

    await this.store.saveWorkspaceStatus(status);
    return status;
  }

  private async resolveActionableCandidates(
    workspace: OrchestratorWorkspaceConfig,
    issues: TrackedIssue[]
  ): Promise<TrackedIssue[]> {
    const candidates: TrackedIssue[] = [];

    for (const issue of issues) {
      const resolution = await this.loadIssueWorkflow(
        workspace,
        issue.repository
      );
      const phase = resolveWorkflowExecutionPhase(
        issue.state,
        resolution.lifecycle
      );

      if (!isWorkflowPhaseActionable(phase)) {
        continue;
      }

      candidates.push({
        ...issue,
        phase,
      });
    }

    return candidates;
  }

  private async loadIssueWorkflow(
    workspace: OrchestratorWorkspaceConfig,
    repository: RepositoryRef
  ) {
    const cacheRoot = join(
      workspace.runtime.workspaceRuntimeDir,
      "workflow-cache",
      repository.owner,
      repository.name
    );
    const repositoryDirectory = await cloneRepositoryForRun({
      repository,
      targetDirectory: cacheRoot,
    });
    return loadRepositoryWorkflow(repositoryDirectory, repository);
  }

  private async startRun(
    workspace: OrchestratorWorkspaceConfig,
    issue: TrackedIssue
  ): Promise<OrchestratorRunRecord> {
    const trackerAdapter = resolveTrackerAdapter(workspace.tracker);
    const now = this.now();
    const runId = createRunId(now, workspace.workspaceId, issue.identifier);
    const runDir = this.store.runDir(runId);
    const workspaceRuntimeDir = join(runDir, "workspace-runtime");

    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      workspaceId: workspace.workspaceId,
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const workspaceKey = deriveIssueWorkspaceKey(identity);
    const issueWorkspacePath = resolveIssueWorkspaceDirectory(
      workspace.runtime.workspaceRuntimeDir,
      workspace.workspaceId,
      workspaceKey
    );

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository: issue.repository,
      issueWorkspacePath,
    });

    const existingWorkspaceRecord = await this.store.loadIssueWorkspace(
      workspace.workspaceId,
      workspaceKey
    );
    if (!existingWorkspaceRecord) {
      const workspaceRecord: IssueWorkspaceRecord = {
        workspaceKey,
        workspaceId: workspace.workspaceId,
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
        repositoryDirectory,
        issue.repository,
        {
          workspaceId: workspace.workspaceId,
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

    const workflow = await loadRepositoryWorkflow(
      repositoryDirectory,
      issue.repository
    );
    const port = this.allocatePort();

    // Render the issue prompt from the workflow template
    const promptVariables = buildPromptVariables(issue, {
      attempt: null, // first execution
      guidelines: workspace.promptGuidelines,
    });
    const renderedPrompt = renderPrompt(
      workflow.promptTemplate,
      promptVariables
    );

    // Run before_run hook before spawning the worker
    await this.runHook("before_run", repositoryDirectory, issue.repository, {
      workspaceId: workspace.workspaceId,
      workspaceKey,
      issueSubjectId,
      issueIdentifier: issue.identifier,
      workspacePath: issueWorkspacePath,
      repositoryPath: repositoryDirectory,
      runId,
      phase: issue.phase,
    });

    const child = (this.dependencies.spawnImpl ?? spawn)(
      "bash",
      ["-lc", workspace.runtime.workerCommand ?? DEFAULT_WORKER_COMMAND],
      {
        cwd: workspace.runtime.projectRoot,
        env: {
          ...process.env,
          CODEX_WORKSPACE_ID: workspace.workspaceId,
          WORKSPACE_ID: workspace.workspaceId,
          WORKING_DIRECTORY: repositoryDirectory,
          WORKSPACE_RUNTIME_DIR: workspaceRuntimeDir,
          WORKSPACE_ALLOWED_REPOSITORIES: workspace.repositories
            .map((repository) => repository.cloneUrl)
            .join(","),
          PORT: String(port),
          SYMPHONY_PORT: String(port),
          SYMPHONY_RUN_ID: runId,
          SYMPHONY_RUN_PHASE: issue.phase,
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
          ...trackerAdapter.buildWorkerEnvironment(workspace, issue),
          SYMPHONY_RENDERED_PROMPT: renderedPrompt,
        },
        detached: true,
        stdio: "ignore",
      }
    );

    child.unref();

    return {
      runId,
      workspaceId: workspace.workspaceId,
      workspaceSlug: workspace.slug,
      issueId: issue.id,
      issueSubjectId,
      issueIdentifier: issue.identifier,
      phase: issue.phase,
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
    };
  }

  private async reconcileRun(
    workspace: OrchestratorWorkspaceConfig,
    run: OrchestratorRunRecord,
    leases: WorkspaceLeaseRecord[]
  ): Promise<{ leases: WorkspaceLeaseRecord[]; recovered: boolean }> {
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
        const runningRecord: OrchestratorRunRecord = {
          ...run,
          status: "running",
          updatedAt: now.toISOString(),
        };
        await this.store.saveRun(runningRecord);
        return {
          leases,
          recovered: false,
        };
      }
    }

    if (
      run.attempt >= (this.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    ) {
      const failedRecord: OrchestratorRunRecord = {
        ...run,
        status: "failed",
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        retryKind: run.retryKind ?? "failure",
        lastError: run.lastError ?? "Worker process exited unexpectedly.",
      };
      await this.store.saveRun(failedRecord);
      return {
        leases: releaseLease(leases, buildLeaseKey(run), now),
        recovered: false,
      };
    }

    if (run.status === "retrying" && run.nextRetryAt) {
      if (new Date(run.nextRetryAt).getTime() > now.getTime()) {
        return {
          leases,
          recovered: false,
        };
      }

      return this.restartRun(workspace, run, leases, now);
    }

    if (run.issueWorkspaceKey) {
      const issueWorkspacePath = resolveIssueWorkspaceDirectory(
        workspace.runtime.workspaceRuntimeDir,
        workspace.workspaceId,
        run.issueWorkspaceKey
      );

      await this.runHook("after_run", run.workingDirectory, run.repository, {
        workspaceId: run.workspaceId,
        workspaceKey: run.issueWorkspaceKey,
        issueSubjectId: run.issueSubjectId,
        issueIdentifier: run.issueIdentifier,
        workspacePath: issueWorkspacePath,
        repositoryPath: run.workingDirectory,
        runId: run.runId,
        phase: run.phase,
      });
    }

    // Determine retry kind: continuation (issue still actionable) vs failure
    const retryKind = await this.classifyRetryKind(workspace, run);
    const retryOptions = await this.loadRetryPolicy(workspace, run.repository);

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
      ...run,
      status: "retrying",
      attempt: run.attempt + 1,
      processId: null,
      updatedAt: now.toISOString(),
      nextRetryAt,
      retryKind,
      lastError:
        retryKind === "continuation"
          ? null
          : "Worker process exited unexpectedly.",
    };
    await this.store.saveRun(retryRecord);
    return {
      leases,
      recovered: false,
    };
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private allocatePort(): number {
    this.nextPort += 1;
    return this.nextPort;
  }

  private initializePortFrom(runs: OrchestratorRunRecord[]): void {
    const maxPort = runs.reduce((max, run) => Math.max(max, run.port ?? 0), DEFAULT_PORT_BASE);
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
    workspace: OrchestratorWorkspaceConfig,
    run: OrchestratorRunRecord
  ): Promise<"continuation" | "failure"> {
    try {
      const trackerAdapter = resolveTrackerAdapter(workspace.tracker);
      const issues = await trackerAdapter.listIssues(workspace, {
        fetchImpl: this.dependencies.fetchImpl,
      });
      const runIssue = issues.find(
        (issue) => issue.identifier === run.issueIdentifier
      );
      if (!runIssue) {
        return "failure";
      }
      const resolution = await this.loadIssueWorkflow(
        workspace,
        run.repository
      );
      const phase = resolveWorkflowExecutionPhase(
        runIssue.state,
        resolution.lifecycle
      );
      return isWorkflowPhaseActionable(phase) ? "continuation" : "failure";
    } catch {
      return "failure";
    }
  }

  /**
   * Execute a workspace lifecycle hook using the workflow configuration
   * loaded from the repository. Returns the hook result or null if the
   * workflow could not be loaded.
   */
  private async runHook(
    kind: "after_create" | "before_run" | "after_run" | "before_remove",
    repositoryDirectory: string,
    repository: RepositoryRef,
    context: {
      workspaceId: string;
      workspaceKey: string;
      issueSubjectId: string;
      issueIdentifier: string;
      workspacePath: string;
      repositoryPath: string;
      runId?: string;
      phase?: string;
    }
  ): Promise<HookResult | null> {
    try {
      const workflow = await loadRepositoryWorkflow(
        repositoryDirectory,
        repository
      );
      const hookEnv = buildHookEnv(context);
      return executeWorkspaceHook({
        kind,
        hooks: workflow.workflow.runtime.hooks,
        repositoryPath: repositoryDirectory,
        env: hookEnv,
      });
    } catch {
      // If workflow cannot be loaded, skip hook execution
      return null;
    }
  }

  private async restartRun(
    workspace: OrchestratorWorkspaceConfig,
    run: OrchestratorRunRecord,
    leases: WorkspaceLeaseRecord[],
    now: Date
  ): Promise<{ leases: WorkspaceLeaseRecord[]; recovered: boolean }> {
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

    const issue = resolveTrackerAdapter(workspace.tracker).reviveIssue(
      workspace,
      run
    );
    const restarted = await this.startRun(workspace, issue);
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
    });

    return {
      leases: upsertLease(leases, {
        leaseKey: buildLeaseKey(run),
        runId: recoveredRecord.runId,
        issueId: recoveredRecord.issueId,
        issueIdentifier: recoveredRecord.issueIdentifier,
        phase: recoveredRecord.phase,
        status: "active",
        updatedAt: now.toISOString(),
      }),
      recovered: true,
    };
  }

  private async loadWorkspacePollInterval(
    workspace: OrchestratorWorkspaceConfig
  ): Promise<number> {
    const intervals = await Promise.all(
      workspace.repositories.map(async (repository) => {
        const resolution = await this.loadIssueWorkflow(workspace, repository);
        return resolution.workflow.scheduler.pollIntervalMs;
      })
    );
    const validIntervals = intervals.filter(
      (value) => Number.isFinite(value) && value > 0
    );
    return validIntervals.length
      ? Math.min(...validIntervals)
      : DEFAULT_POLL_INTERVAL_MS;
  }

  private async loadRetryPolicy(
    workspace: OrchestratorWorkspaceConfig,
    repository: RepositoryRef
  ): Promise<{ baseDelayMs: number; maxDelayMs: number } | null> {
    if (this.dependencies.retryBackoffMs) {
      return {
        baseDelayMs: this.dependencies.retryBackoffMs,
        maxDelayMs: this.dependencies.retryBackoffMs,
      };
    }

    try {
      const resolution = await this.loadIssueWorkflow(workspace, repository);
      return resolution.workflow.retry;
    } catch {
      return null;
    }
  }

  /**
   * Clean up the issue workspace for a terminal (completed) issue.
   *
   * Runs the `before_remove` hook if configured. If the hook fails,
   * the workspace transitions to `cleanup_blocked` (fail-closed per design
   * decision 12). If it succeeds, the workspace directory is removed and
   * the record set to `removed`. Orchestration records (runs) are preserved.
   */
  private async cleanupTerminalIssueWorkspace(
    workspace: OrchestratorWorkspaceConfig,
    issue: TrackedIssue,
    now: Date
  ): Promise<void> {
    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      workspaceId: workspace.workspaceId,
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const workspaceKey = deriveIssueWorkspaceKey(identity);
    const workspaceRecord = await this.store.loadIssueWorkspace(
      workspace.workspaceId,
      workspaceKey
    );

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
      workspaceRecord.repositoryPath,
      issue.repository,
      {
        workspaceId: workspace.workspaceId,
        workspaceKey,
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

export function createStore(runtimeRoot = ".runtime") {
  return new OrchestratorFsStore(runtimeRoot);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRunId(
  now: Date,
  workspaceId: string,
  issueIdentifier: string
): string {
  return [
    workspaceId,
    issueIdentifier.replace(/[^a-zA-Z0-9]+/g, "-"),
    now.getTime().toString(36),
  ].join("-");
}

function buildLeaseKey(
  record:
    | Pick<TrackedIssue, "id" | "phase">
    | Pick<OrchestratorRunRecord, "issueId" | "phase">
): string {
  const issueId = "id" in record ? record.id : record.issueId;
  return `${issueId}:${record.phase}`;
}

function upsertLease(
  leases: WorkspaceLeaseRecord[],
  nextLease: WorkspaceLeaseRecord
): WorkspaceLeaseRecord[] {
  const remaining = leases.filter(
    (lease) => lease.leaseKey !== nextLease.leaseKey
  );
  return [...remaining, nextLease];
}

function releaseLease(
  leases: WorkspaceLeaseRecord[],
  leaseKey: string,
  now: Date
): WorkspaceLeaseRecord[] {
  return leases.map((lease) =>
    lease.leaseKey === leaseKey
      ? {
          ...lease,
          status: "released",
          updatedAt: now.toISOString(),
        }
      : lease
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

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

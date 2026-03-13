import { readFile, rm } from "node:fs/promises";
import { mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";
import {
  buildHookEnv,
  buildPromptVariables,
  buildTenantSnapshot,
  deriveIssueWorkspaceKey,
  executeWorkspaceHook,
  isStateActive,
  isStateTerminal,
  matchesWorkflowState,
  renderPrompt,
  resolveIssueWorkspaceDirectory,
  scheduleRetryAt,
  type HookResult,
  type IssueSubjectIdentity,
  type IssueWorkspaceRecord,
  type OrchestratorRunRecord,
  type OrchestratorStateStore,
  type OrchestratorTenantConfig,
  type RepositoryRef,
  type TrackedIssue,
  type WorkflowLifecycleConfig,
  type TenantLeaseRecord,
  type TenantStatusSnapshot,
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

export class OrchestratorService {
  private nextPort = DEFAULT_PORT_BASE;
  private readonly tenantPollIntervals = new Map<string, number>();

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
      tenantId?: string;
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
      tenantId?: string;
      issueIdentifier?: string;
    } = {}
  ): Promise<TenantStatusSnapshot[]> {
    const tenants = await this.loadTargetTenants(options.tenantId);
    return Promise.all(
      tenants.map((tenant) =>
        this.reconcileTenant(tenant, options.issueIdentifier)
      )
    );
  }

  async status(tenantId?: string): Promise<TenantStatusSnapshot[]> {
    const tenants = await this.loadTargetTenants(tenantId);
    const statuses = await Promise.all(
      tenants.map((tenant) => this.store.loadTenantStatus(tenant.tenantId))
    );

    return statuses.filter((status): status is TenantStatusSnapshot =>
      Boolean(status)
    );
  }

  async recover(tenantId?: string): Promise<TenantStatusSnapshot[]> {
    return this.runOnce({
      tenantId,
    });
  }

  getEffectivePollIntervalMs(): number {
    if (this.dependencies.pollIntervalMs) {
      return this.dependencies.pollIntervalMs;
    }

    const configuredIntervals = [...this.tenantPollIntervals.values()].filter(
      (value) => Number.isFinite(value) && value > 0
    );
    return configuredIntervals.length
      ? Math.min(...configuredIntervals)
      : DEFAULT_POLL_INTERVAL_MS;
  }

  private async loadTargetTenants(
    tenantId?: string
  ): Promise<OrchestratorTenantConfig[]> {
    const tenants = await this.store.loadTenantConfigs();
    return tenantId
      ? tenants.filter((tenant) => tenant.tenantId === tenantId)
      : tenants;
  }

  private async reconcileTenant(
    tenant: OrchestratorTenantConfig,
    issueIdentifier?: string
  ): Promise<TenantStatusSnapshot> {
    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const now = this.now();
    let lastError: string | null = null;
    let dispatched = 0;
    let suppressed = 0;
    let recovered = 0;
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

    let leases = await this.store.loadTenantLeases(tenant.tenantId);
    const allRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.tenantId === tenant.tenantId
    );
    const activeRuns = allRuns.filter((run) => isActiveRunStatus(run.status));
    this.initializePortFrom(allRuns);

    for (const run of activeRuns) {
      const outcome = await this.reconcileRun(tenant, run, leases);
      leases = outcome.leases;
      if (outcome.recovered) {
        recovered += 1;
      }
    }

    try {
      pollIntervalMs = await this.loadTenantPollInterval(tenant);
      const issues = await trackerAdapter.listIssues(tenant, {
        fetchImpl: this.dependencies.fetchImpl,
      });
      const filteredIssues = issueIdentifier
        ? issues.filter(
            (issue: TrackedIssue) => issue.identifier === issueIdentifier
          )
        : issues;
      const { candidates: actionableCandidates, lifecycle } =
        await this.resolveActionableCandidates(tenant, filteredIssues);
      const concurrency = this.getTenantConcurrency(tenant);
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

      // Sort candidates by priority (asc, null last) → createdAt (oldest) → identifier (lexicographic)
      const sortedCandidates = sortCandidatesForDispatch(unscheduledCandidates);

      // Count active runs by state for per-state concurrency limits
      const activeByState = new Map<string, number>();
      for (const run of activeRuns) {
        const state = run.issueState;
        const count = activeByState.get(state) ?? 0;
        activeByState.set(state, count + 1);
      }

      // Load per-state concurrency limits from workflow config
      const maxConcurrentByState =
        await this.loadTenantMaxConcurrentByState(tenant);

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

        const leaseKey = buildLeaseKey(issue);
        const run = await this.startRun(tenant, issue);
        leases = upsertLease(leases, {
          leaseKey,
          runId: run.runId,
          issueId: run.issueId,
          issueIdentifier: run.issueIdentifier,
          status: "active",
          updatedAt: now.toISOString(),
        });
        await this.store.saveRun(run);
        await this.store.appendRunEvent(run.runId, {
          at: now.toISOString(),
          event: "run-dispatched",
          tenantId: tenant.tenantId,
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

    this.tenantPollIntervals.set(tenant.tenantId, pollIntervalMs);
    await this.store.saveTenantLeases(tenant.tenantId, leases);

    const allTenantRuns = (await this.store.loadAllRuns()).filter(
      (run) => run.tenantId === tenant.tenantId
    );
    const latestRuns = allTenantRuns.filter((run) =>
      isActiveRunStatus(run.status)
    );
    const status = buildTenantSnapshot({
      tenant,
      activeRuns: latestRuns,
      allRuns: allTenantRuns,
      summary: { dispatched, suppressed, recovered },
      lastTickAt: now.toISOString(),
      lastError,
    });
    await this.store.saveTenantStatus(status);
    return status;
  }

  private async resolveActionableCandidates(
    tenant: OrchestratorTenantConfig,
    issues: TrackedIssue[]
  ): Promise<{
    candidates: TrackedIssue[];
    lifecycle: WorkflowLifecycleConfig;
  }> {
    const candidates: TrackedIssue[] = [];
    let lifecycle: WorkflowLifecycleConfig | null = null;

    for (const issue of issues) {
      const resolution = await this.loadTenantWorkflow(
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
      const resolution = await this.loadTenantWorkflow(
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

  private async loadTenantWorkflow(
    tenant: OrchestratorTenantConfig,
    repository: RepositoryRef
  ) {
    const cacheRoot = join(
      tenant.runtime.workspaceRuntimeDir,
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
    tenant: OrchestratorTenantConfig,
    issue: TrackedIssue
  ): Promise<OrchestratorRunRecord> {
    const trackerAdapter = resolveTrackerAdapter(tenant.tracker);
    const now = this.now();
    const runId = createRunId(now, tenant.tenantId, issue.identifier);
    const runDir = this.store.runDir(runId);
    const workspaceRuntimeDir = join(runDir, "workspace-runtime");

    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      tenantId: tenant.tenantId,
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const workspaceKey = deriveIssueWorkspaceKey(identity);
    const issueWorkspacePath = resolveIssueWorkspaceDirectory(
      tenant.runtime.workspaceRuntimeDir,
      tenant.tenantId,
      workspaceKey
    );

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository: issue.repository,
      issueWorkspacePath,
    });

    const existingWorkspaceRecord = await this.store.loadIssueWorkspace(
      tenant.tenantId,
      workspaceKey
    );
    if (!existingWorkspaceRecord) {
      const workspaceRecord: IssueWorkspaceRecord = {
        workspaceKey,
        tenantId: tenant.tenantId,
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
          tenantId: tenant.tenantId,
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

    const workflow = await this.loadTenantWorkflow(tenant, issue.repository);
    if (!workflow.isValid) {
      throw new Error(
        workflow.validationError ?? "Invalid repository WORKFLOW.md"
      );
    }
    const port = this.allocatePort();

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
        tenantId: tenant.tenantId,
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
      ["-lc", tenant.runtime.workerCommand ?? DEFAULT_WORKER_COMMAND],
      {
        cwd: tenant.runtime.projectRoot,
        env: {
          ...process.env,
          CODEX_TENANT_ID: tenant.tenantId,
          TENANT_ID: tenant.tenantId,
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
      tenantId: tenant.tenantId,
      tenantSlug: tenant.slug,
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
    };
  }

  private async reconcileRun(
    tenant: OrchestratorTenantConfig,
    run: OrchestratorRunRecord,
    leases: TenantLeaseRecord[]
  ): Promise<{ leases: TenantLeaseRecord[]; recovered: boolean }> {
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
        };
        await this.store.saveRun(runningRecord);
        return {
          leases,
          recovered: false,
        };
      }
    }

    // Attempt to capture final token usage and session info from the worker
    // state API before the worker process fully exits.
    const workerInfo = await this.fetchWorkerRunInfo(run);
    const runWithTokens: OrchestratorRunRecord = workerInfo.tokenUsage
      ? { ...run, tokenUsage: workerInfo.tokenUsage }
      : run;
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

    if (run.attempt >= this.getTenantMaxAttempts(tenant)) {
      const failedRecord: OrchestratorRunRecord = {
        ...runWithTokens,
        status: "failed",
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        retryKind: runWithTokens.retryKind ?? "failure",
        lastError:
          runWithTokens.lastError ?? "Worker process exited unexpectedly.",
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

      return this.restartRun(tenant, run, leases, now, workerSessionId);
    }

    if (run.issueWorkspaceKey) {
      const issueWorkspacePath = resolveIssueWorkspaceDirectory(
        tenant.runtime.workspaceRuntimeDir,
        tenant.tenantId,
        run.issueWorkspaceKey
      );

      await this.runHook(
        "after_run",
        tenant,
        run.workingDirectory,
        run.repository,
        {
          tenantId: run.tenantId,
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
    tenant: OrchestratorTenantConfig,
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
      const resolution = await this.loadTenantWorkflow(tenant, run.repository);
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
    };
  }

  private async fetchLiveWorkerState(run: OrchestratorRunRecord): Promise<{
    tokenUsage: OrchestratorRunRecord["tokenUsage"] | null;
    sessionId: string | null;
    turnCount: number | null;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
  }> {
    if (!run.port) {
      return {
        tokenUsage: null,
        sessionId: null,
        turnCount: null,
        lastError: null,
        lastEvent: null,
        lastEventAt: null,
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
        };
      }

      const state = (await response.json()) as {
        status?: string;
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

      return {
        tokenUsage,
        sessionId,
        turnCount,
        lastError,
        lastEvent,
        lastEventAt,
      };
    } catch {
      return {
        tokenUsage: null,
        sessionId: null,
        turnCount: null,
        lastError: null,
        lastEvent: null,
        lastEventAt: null,
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
    tenant: OrchestratorTenantConfig,
    repositoryDirectory: string,
    repository: RepositoryRef,
    context: {
      tenantId: string;
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
      const resolution = await this.loadTenantWorkflow(tenant, repository);
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
    tenant: OrchestratorTenantConfig,
    run: OrchestratorRunRecord,
    leases: TenantLeaseRecord[],
    now: Date,
    sessionId?: string | null
  ): Promise<{ leases: TenantLeaseRecord[]; recovered: boolean }> {
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
      leases: upsertLease(leases, {
        leaseKey: buildLeaseKey(run),
        runId: recoveredRecord.runId,
        issueId: recoveredRecord.issueId,
        issueIdentifier: recoveredRecord.issueIdentifier,
        status: "active",
        updatedAt: now.toISOString(),
      }),
      recovered: true,
    };
  }

  private async loadTenantPollInterval(
    tenant: OrchestratorTenantConfig
  ): Promise<number> {
    const intervals = await Promise.all(
      tenant.repositories.map(async (repository) => {
        const resolution = await this.loadTenantWorkflow(tenant, repository);
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

  private async loadTenantMaxConcurrentByState(
    tenant: OrchestratorTenantConfig
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const resolutions = await Promise.all(
      tenant.repositories.map(async (repository) => {
        try {
          return await this.loadTenantWorkflow(tenant, repository);
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
    tenant: OrchestratorTenantConfig,
    repository: RepositoryRef
  ): Promise<{ baseDelayMs: number; maxDelayMs: number } | null> {
    if (this.dependencies.retryBackoffMs) {
      return {
        baseDelayMs: this.dependencies.retryBackoffMs,
        maxDelayMs: this.dependencies.retryBackoffMs,
      };
    }

    try {
      const resolution = await this.loadTenantWorkflow(tenant, repository);
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

  private getTenantConcurrency(_tenant: OrchestratorTenantConfig): number {
    return this.dependencies.concurrency ?? DEFAULT_CONCURRENCY;
  }

  private getTenantMaxAttempts(_tenant: OrchestratorTenantConfig): number {
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
    tenant: OrchestratorTenantConfig,
    issue: TrackedIssue,
    now: Date
  ): Promise<void> {
    const issueSubjectId = issue.id;
    const identity: IssueSubjectIdentity = {
      tenantId: tenant.tenantId,
      adapter: issue.tracker.adapter,
      issueSubjectId,
    };
    const workspaceKey = deriveIssueWorkspaceKey(identity);
    const workspaceRecord = await this.store.loadIssueWorkspace(
      tenant.tenantId,
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
      tenant,
      workspaceRecord.repositoryPath,
      issue.repository,
      {
        tenantId: tenant.tenantId,
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
  tenantId: string,
  issueIdentifier: string
): string {
  return [
    tenantId,
    issueIdentifier.replace(/[^a-zA-Z0-9]+/g, "-"),
    now.getTime().toString(36),
  ].join("-");
}

function buildLeaseKey(
  record: Pick<TrackedIssue, "id"> | Pick<OrchestratorRunRecord, "issueId">
): string {
  return "id" in record ? record.id : record.issueId;
}

function upsertLease(
  leases: TenantLeaseRecord[],
  nextLease: TenantLeaseRecord
): TenantLeaseRecord[] {
  const remaining = leases.filter(
    (lease) => lease.leaseKey !== nextLease.leaseKey
  );
  return [...remaining, nextLease];
}

function releaseLease(
  leases: TenantLeaseRecord[],
  leaseKey: string,
  now: Date
): TenantLeaseRecord[] {
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

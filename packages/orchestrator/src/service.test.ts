import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveIssueWorkspaceKey,
  resolveIssueWorkspaceDirectory,
} from "@gh-symphony/core";
import { OrchestratorFsStore } from "./fs-store.js";
import { OrchestratorService } from "./service.js";

describe("OrchestratorService", () => {
  const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_GRAPHQL_TOKEN;
    } else {
      process.env.GITHUB_GRAPHQL_TOKEN = originalToken;
    }
  });

  it("dispatches actionable issues and prevents duplicate issue leases", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4101,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const first = await service.runOnce();
    const second = await service.runOnce();
    const issueRecords = await store.loadProjectIssueOrchestrations("tenant-1");

    expect(first.summary.dispatched).toBe(1);
    expect(first.tracker).toEqual({
      adapter: "github-project",
      bindingId: "project-123",
    });
    expect(second.summary.dispatched).toBe(0);
    expect(issueRecords).toHaveLength(1);
    expect(issueRecords[0]?.state).toBe("retry_queued");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("packages/worker/dist/index.js")],
      expect.objectContaining({
        env: expect.objectContaining({
          GITHUB_PROJECT_ID: "project-123",
          SYMPHONY_TRACKER_ADAPTER: "github-project",
          SYMPHONY_TRACKER_BINDING_ID: "project-123",
          SYMPHONY_TRACKER_ITEM_ID: "item-1",
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-1",
          SYMPHONY_ISSUE_WORKSPACE_KEY: expect.any(String),
        }),
      })
    );
  });

  it("tracks active worker pids and escalates to SIGKILL during shutdown", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-shutdown-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const livePids = new Set([4101]);
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        livePids.delete(pid);
      }
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4101,
        unref: vi.fn(),
      }) as never,
      killImpl,
      isProcessRunning: (pid) => livePids.has(pid),
      waitImpl: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    await service.shutdown();

    expect(killImpl).toHaveBeenNthCalledWith(1, 4101, "SIGTERM");
    expect(killImpl).toHaveBeenNthCalledWith(2, 4101, "SIGKILL");
  });

  it("removes suppressed worker pids from shutdown tracking", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-suppress-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const livePids = new Set([4101]);
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        livePids.delete(pid);
      }
    });
    const waitImpl = vi.fn().mockResolvedValue(undefined);
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(createTrackerResponse(repository))
        .mockResolvedValueOnce(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4101,
        unref: vi.fn(),
      }) as never,
      killImpl,
      isProcessRunning: (pid) => livePids.has(pid),
      waitImpl,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    await service.runOnce();
    await service.shutdown();

    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(4101, "SIGTERM");
    expect(waitImpl).not.toHaveBeenCalled();
  });

  it("skips shutdown wait when there are no active workers", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-idle-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const waitImpl = vi.fn().mockResolvedValue(undefined);
    const service = new OrchestratorService(store, projectConfig, {
      waitImpl,
    });

    await service.shutdown();

    expect(waitImpl).not.toHaveBeenCalled();
  });

  it("restarts retrying runs after backoff elapses", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-retry-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "retrying",
      attempt: 2,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "stale-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "stale-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: "failure",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:10.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: "Worker process exited unexpectedly.",
      nextRetryAt: "2026-03-08T00:00:20.000Z",
    });

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4102,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:01:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.recovered).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("builds issue-specific debug status for a tracked issue", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-issue-status-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "retry_queued",
        currentRunId: "run-1",
        retryEntry: {
          attempt: 2,
          dueAt: "2026-03-08T00:03:00.000Z",
          error: "worker failed",
        },
        updatedAt: "2026-03-08T00:02:30.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "In Progress",
      repository,
      status: "retrying",
      attempt: 2,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "run-1", "repo"),
      issueWorkspaceKey: "acme_platform_1",
      workspaceRuntimeDir: join(tempRoot, "run-1", "workspace-runtime"),
      workflowPath: null,
      retryKind: "failure",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:02:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: "worker failed",
      nextRetryAt: "2026-03-08T00:03:00.000Z",
      runtimeSession: {
        sessionId: "session-1",
        threadId: "thread-1",
        status: "active",
        startedAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:02:00.000Z",
        exitClassification: null,
      },
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
      },
      turnCount: 4,
      lastEvent: "worker-error",
      lastEventAt: "2026-03-08T00:02:00.000Z",
      executionPhase: "implementation",
      runPhase: "failed",
    });
    await store.appendRunEvent("run-1", {
      at: "2026-03-08T00:02:00.000Z",
      event: "worker-error",
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      error: "worker failed",
      attempt: 2,
    });

    const service = new OrchestratorService(store, projectConfig);

    await expect(service.statusForIssue("acme/platform#1")).resolves.toEqual({
      issue_identifier: "acme/platform#1",
      issue_id: "issue-1",
      status: "retrying",
      workspace: {
        path: join(tempRoot, "run-1", "repo"),
      },
      attempts: {
        restart_count: 1,
        current_retry_attempt: 2,
      },
      running: {
        session_id: "session-1",
        turn_count: 4,
        state: "In Progress",
        started_at: "2026-03-08T00:00:00.000Z",
        last_event: "worker-error",
        last_message: "worker failed",
        last_event_at: "2026-03-08T00:02:00.000Z",
        tokens: {
          input_tokens: 120,
          output_tokens: 40,
          total_tokens: 160,
        },
      },
      retry: {
        due_at: "2026-03-08T00:03:00.000Z",
        kind: "failure",
        error: "worker failed",
      },
      logs: {
        codex_session_logs: [
          {
            label: "worker",
            path: join(store.runDir("run-1"), "worker.log"),
            url: null,
          },
        ],
      },
      recent_events: [
        {
          at: "2026-03-08T00:02:00.000Z",
          event: "worker-error",
          message: "worker failed",
        },
      ],
      last_error: "worker failed",
      tracked: {
        issue_orchestration_state: "retry_queued",
        current_run_id: "run-1",
        workspace_key: "acme_platform_1",
        run_phase: "failed",
        execution_phase: "implementation",
      },
    });
  });

  it("uses currentRunId before falling back to a full run scan", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-issue-status-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:02:30.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "In Progress",
      repository,
      status: "running",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "run-1", "repo"),
      issueWorkspaceKey: "acme_platform_1",
      workspaceRuntimeDir: join(tempRoot, "run-1", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:02:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    const loadAllRunsSpy = vi.spyOn(store, "loadAllRuns");
    const service = new OrchestratorService(store, projectConfig);

    await expect(service.statusForIssue("acme/platform#1")).resolves.toMatchObject(
      {
        issue_identifier: "acme/platform#1",
        status: "running",
      }
    );
    expect(loadAllRunsSpy).not.toHaveBeenCalled();
  });

  it("reloads workflow poll intervals for future ticks without restart", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-poll-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4103,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    expect(service.getEffectivePollIntervalMs()).toBe(30000);

    await commitWorkflowFixture(repository.path, {
      schedulerPollIntervalMs: 5000,
    });

    await service.runOnce();
    expect(service.getEffectivePollIntervalMs()).toBe(5000);
  });

  it("uses the latest workflow retry policy for future retries", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-retry-policy-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        retryBaseDelayMs: 7000,
        retryMaxDelayMs: 7000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "stale-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "stale-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4104,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(updatedRun?.status).toBe("retrying");
    expect(updatedRun?.nextRetryAt).toBe("2026-03-08T00:00:07.000Z");
    expect(updatedRun?.retryKind).toBe("failure");
  });

  it("uses a fixed 1000ms delay for continuation retries", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-continuation-retry-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        retryBaseDelayMs: 7000,
        retryMaxDelayMs: 7000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "stale-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "stale-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo")) as never,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4105,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });
    const loadRetryPolicySpy = vi.spyOn(service as never, "loadRetryPolicy");

    await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(updatedRun?.status).toBe("retrying");
    expect(updatedRun?.nextRetryAt).toBe("2026-03-08T00:00:01.000Z");
    expect(updatedRun?.retryKind).toBe("continuation");
    expect(updatedRun?.lastError).toBeNull();
    expect(loadRetryPolicySpy).not.toHaveBeenCalled();
  });

  it("terminates a running worker when lastEventAt exceeds the workflow stall timeout", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-stall-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        retryBaseDelayMs: 7000,
        retryMaxDelayMs: 7000,
        stallTimeoutMs: 120000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: 4106,
      port: 4601,
      workingDirectory: join(tempRoot, "active-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "active-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:02:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      lastEventAt: "2026-03-08T00:02:00.000Z",
    });

    const killImpl = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        throw new Error("worker shutting down");
      }
      return createTrackerResponseWithState(repository, "In Progress");
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4206,
        unref: vi.fn(),
      }) as never,
      killImpl,
      isProcessRunning: (pid) => pid === 4106,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
    });

    await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(killImpl).toHaveBeenCalledWith(4106, "SIGTERM");
    expect(updatedRun?.status).toBe("retrying");
    expect(updatedRun?.nextRetryAt).toBe("2026-03-08T00:05:01.000Z");
    expect(updatedRun?.retryKind).toBe("continuation");
  });

  it("uses lastEventAt instead of startedAt for stall detection when recent activity exists", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stall-activity-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        stallTimeoutMs: 300000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: 4107,
      port: 4601,
      workingDirectory: join(tempRoot, "active-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "active-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:04:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      lastEventAt: "2026-03-08T00:04:00.000Z",
    });

    const killImpl = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        return {
          ok: true,
          json: async () => ({
            status: "running",
            executionPhase: "implementation",
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 4,
              totalTokens: 14,
            },
            sessionInfo: {
              threadId: "thread-1",
              turnId: "turn-xyz",
              turnCount: 2,
              sessionId: "thread-1-turn-xyz",
            },
            run: {
              lastError: null,
            },
          }),
        } as Response;
      }
      return createTrackerResponseWithState(repository, "Todo");
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4207,
        unref: vi.fn(),
      }) as never,
      killImpl,
      isProcessRunning: (pid) => pid === 4107,
      now: () => new Date("2026-03-08T00:06:00.000Z"),
    });

    const snapshot = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(killImpl).not.toHaveBeenCalled();
    expect(snapshot.activeRuns[0]?.status).toBe("running");
    expect(updatedRun?.status).toBe("running");
    expect(updatedRun?.runtimeSession?.sessionId).toBe("thread-1-turn-xyz");
  });

  it("disables workflow stall detection when stall_timeout_ms <= 0 but keeps the 30 minute fallback", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stall-disabled-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        retryBaseDelayMs: 7000,
        retryMaxDelayMs: 7000,
        stallTimeoutMs: 0,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: 4108,
      port: 4601,
      workingDirectory: join(tempRoot, "active-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "active-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:20:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      lastEventAt: "2026-03-08T00:20:00.000Z",
    });

    const killImpl = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        throw new Error("worker shutting down");
      }
      return createTrackerResponseWithState(repository, "In Progress");
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4208,
        unref: vi.fn(),
      }) as never,
      killImpl,
      isProcessRunning: (pid) => pid === 4108,
      now: () => new Date("2026-03-08T00:31:00.000Z"),
    });

    await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(killImpl).toHaveBeenCalledWith(4108, "SIGTERM");
    expect(updatedRun?.status).toBe("retrying");
    expect(updatedRun?.nextRetryAt).toBe("2026-03-08T00:31:01.000Z");
    expect(updatedRun?.retryKind).toBe("continuation");
  });

  it("does not execute after_run while waiting for a retry schedule", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-retrying-hook-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        includeAfterRunHook: true,
      }
    );
    execSync(`mkdir -p ${shell(join(repository.path, "hooks"))}`);
    await writeFile(
      join(repository.path, "hooks", "after_run.sh"),
      "#!/usr/bin/env bash\nset -eu\nprintf 'called' > \"$SYMPHONY_REPOSITORY_PATH/.after_run_called\"\n",
      "utf8"
    );
    execSync(`git -C ${shell(repository.path)} add hooks/after_run.sh`, {
      stdio: "ignore",
    });
    execSync(`git -C ${shell(repository.path)} commit -m add-after-run-hook`, {
      stdio: "ignore",
    });

    const store = new OrchestratorFsStore(tempRoot);
    const workspaceDir = join(tempRoot, "workspace-runtime-root");
    const projectConfig = createProjectConfig(
      tempRoot,
      repository,
      workspaceDir
    );
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });

    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "retrying",
      attempt: 2,
      processId: null,
      port: 4601,
      workingDirectory: repository.path,
      issueWorkspaceKey: workspaceKey,
      workspaceRuntimeDir: join(tempRoot, "stale-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: "failure",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:10.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: "Worker process exited unexpectedly.",
      nextRetryAt: "2026-03-08T00:00:20.000Z",
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4201,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:15.000Z"),
    });

    await service.runOnce();

    await expect(
      readFile(join(repository.path, ".after_run_called"), "utf8")
    ).rejects.toThrow();
  });

  it("falls back to persisted token usage when the worker state API is unavailable", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-token-usage-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const workspaceRuntimeDir = join(
      tempRoot,
      "stale-run",
      "workspace-runtime"
    );
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "stale-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir,
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });
    await mkdir(join(workspaceRuntimeDir, ".orchestrator", "runs", "run-1"), {
      recursive: true,
    });
    await writeFile(
      join(
        workspaceRuntimeDir,
        ".orchestrator",
        "runs",
        "run-1",
        "token-usage.json"
      ),
      JSON.stringify(
        {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
        null,
        2
      ),
      "utf8"
    );

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        throw new Error("worker offline");
      }
      return createEmptyTrackerResponse();
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4203,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(updatedRun?.tokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  it("captures worker executionPhase from the live state endpoint", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-live-phase-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "active-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "active-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        return {
          ok: true,
          json: async () => ({
            status: "running",
            sessionId: "thread-1-turn-abc",
            executionPhase: "planning",
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 4,
              totalTokens: 14,
            },
            sessionInfo: {
              threadId: "thread-1",
              turnId: "turn-abc",
              turnCount: 2,
              sessionId: "thread-1-turn-abc",
            },
            run: {
              lastError: null,
            },
          }),
        } as Response;
      }
      return createEmptyTrackerResponse();
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4204,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
    });

    const snapshot = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(snapshot.activeRuns[0]?.executionPhase).toBe("planning");
    expect(updatedRun?.executionPhase).toBe("planning");
    expect(updatedRun?.tokenUsage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    expect(updatedRun?.runtimeSession?.sessionId).toBe("thread-1-turn-abc");
  });

  it("ignores non-string session identifiers from the live state endpoint", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-live-phase-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "active-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "active-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        return {
          ok: true,
          json: async () => ({
            status: "running",
            sessionId: { invalid: true },
            executionPhase: "planning",
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 4,
              totalTokens: 14,
            },
            sessionInfo: {
              threadId: "thread-1",
              turnId: 123,
              turnCount: 2,
              sessionId: ["bad"],
            },
            run: {
              lastError: null,
            },
          }),
        } as Response;
      }
      return createEmptyTrackerResponse();
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4204,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
    });

    await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(updatedRun?.runtimeSession?.sessionId).toBeNull();
  });

  it("synchronizes active run issueState with the latest tracker status", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-live-state-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "retrying",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "active-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "active-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: "failure",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: "Worker process exited unexpectedly.",
      nextRetryAt: "2026-03-08T00:10:00.000Z",
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "In Progress")) as never,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4204,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
    });

    const snapshot = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(snapshot.activeRuns[0]?.issueState).toBe("In Progress");
    expect(updatedRun?.issueState).toBe("In Progress");
  });

  it("drops invalid worker executionPhase values from the live state endpoint", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-live-phase-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "active-run"),
      issueWorkspaceKey: null,
      workspaceRuntimeDir: join(tempRoot, "active-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        return {
          ok: true,
          json: async () => ({
            status: "running",
            executionPhase: "done-ish",
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 4,
              totalTokens: 14,
            },
            sessionInfo: {
              threadId: "thread-1",
              turnId: "turn-def",
              turnCount: 2,
              sessionId: "thread-1-turn-def",
            },
            run: {
              lastError: null,
            },
          }),
        } as Response;
      }
      return createEmptyTrackerResponse();
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4204,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
    });

    const snapshot = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(snapshot.activeRuns[0]?.executionPhase).toBeNull();
    expect(updatedRun?.executionPhase).toBeNull();
  });

  it("rejects dispatch when repo WORKFLOW.md is missing even if project fallback exists", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-ws-fallback-"));
    const repository = await createBareRepositoryFixture(
      tempRoot,
      "acme",
      "bare-repo"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const projectDir = store.projectDir("tenant-1");
    await writeFile(
      join(projectDir, "WORKFLOW.md"),
      `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Open
  terminal_states:
    - Closed
  blocker_check_states:
    - Open
hooks:
  after_create: hooks/after_create.sh
polling:
  interval_ms: 15000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
---
Workspace prompt.
`,
      "utf8"
    );

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4301,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Open")),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(0);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("uses repo WORKFLOW.md when it is valid", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-repo-wf-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4302,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    // Repo WORKFLOW.md defines Todo as active, issue is in "Todo" → dispatched
    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("passes issue workspace root to after_run hook environment", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-after-run-env-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        includeAfterRunHook: true,
        afterRunCommand:
          'printf "%s" "$SYMPHONY_WORKSPACE_PATH" > "$SYMPHONY_REPOSITORY_PATH/.after_run_workspace_path"\nprintf "%s" "$SYMPHONY_REPOSITORY_PATH" > "$SYMPHONY_REPOSITORY_PATH/.after_run_repository_path"',
      }
    );

    const store = new OrchestratorFsStore(tempRoot);
    const workspaceDir = join(tempRoot, "workspace-runtime-root");
    const projectConfig = createProjectConfig(
      tempRoot,
      repository,
      workspaceDir
    );
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const expectedWorkspacePath = resolveIssueWorkspaceDirectory(
      workspaceDir,
      "tenant-1",
      workspaceKey
    );

    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: 999999,
      port: 4601,
      workingDirectory: repository.path,
      issueWorkspaceKey: workspaceKey,
      workspaceRuntimeDir: join(tempRoot, "stale-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4202,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();

    const workspacePathFromHook = await readFile(
      join(repository.path, ".after_run_workspace_path"),
      "utf8"
    );
    const repositoryPathFromHook = await readFile(
      join(repository.path, ".after_run_repository_path"),
      "utf8"
    );

    expect(workspacePathFromHook).toBe(expectedWorkspacePath);
    expect(repositoryPathFromHook).toBe(repository.path);
  });
});

async function createRepositoryFixture(
  root: string,
  owner: string,
  name: string,
  options: {
    schedulerPollIntervalMs?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    stallTimeoutMs?: number;
    includeAfterRunHook?: boolean;
  } = {}
): Promise<{
  owner: string;
  name: string;
  cloneUrl: string;
  path: string;
}> {
  const repositoryRoot = join(root, `${owner}-${name}`);
  execSync(`mkdir -p ${shell(repositoryRoot)}`);
  execSync(`git init ${shell(repositoryRoot)}`, { stdio: "ignore" });
  execSync(
    `git -C ${shell(repositoryRoot)} config user.email tester@example.com`
  );
  execSync(`git -C ${shell(repositoryRoot)} config user.name tester`);
  await writeWorkflowFixture(repositoryRoot, options);
  execSync(`git -C ${shell(repositoryRoot)} add WORKFLOW.md`, {
    stdio: "ignore",
  });
  execSync(`git -C ${shell(repositoryRoot)} commit -m init`, {
    stdio: "ignore",
  });

  return {
    owner,
    name,
    cloneUrl: repositoryRoot,
    path: repositoryRoot,
  };
}

function createProjectConfig(
  root: string,
  repository: {
    owner: string;
    name: string;
    cloneUrl: string;
  },
  workspaceDir = join(root, "workspaces", "tenant-1")
) {
  return {
    projectId: "tenant-1",
    slug: "tenant-1",
    workspaceDir,
    repositories: [repository],
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    },
  };
}

async function commitWorkflowFixture(
  repositoryRoot: string,
  options: {
    schedulerPollIntervalMs?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    stallTimeoutMs?: number;
    includeAfterRunHook?: boolean;
    afterRunCommand?: string;
  } = {}
): Promise<void> {
  await writeWorkflowFixture(repositoryRoot, options);
  execSync(`git -C ${shell(repositoryRoot)} add WORKFLOW.md`, {
    stdio: "ignore",
  });
  execSync(`git -C ${shell(repositoryRoot)} commit -m workflow-update`, {
    stdio: "ignore",
  });
}

async function writeWorkflowFixture(
  repositoryRoot: string,
  options: {
    schedulerPollIntervalMs?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    stallTimeoutMs?: number;
    includeAfterRunHook?: boolean;
    afterRunCommand?: string;
  } = {}
): Promise<void> {
  await writeFile(
    join(repositoryRoot, "WORKFLOW.md"),
    `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
hooks:
  after_create: hooks/after_create.sh
${options.includeAfterRunHook ? `  after_run: |\n    ${(options.afterRunCommand ?? "hooks/after_run.sh").replace(/\n/g, "\n    ")}` : ""}
polling:
  interval_ms: ${options.schedulerPollIntervalMs ?? 30000}
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_retry_backoff_ms: ${options.retryMaxDelayMs ?? 30000}
  retry_base_delay_ms: ${options.retryBaseDelayMs ?? 1000}
codex:
  command: codex app-server
  read_timeout_ms: 5000
  stall_timeout_ms: ${options.stallTimeoutMs ?? 300000}
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
    "utf8"
  );
}

function createTrackerResponse(repository: {
  owner: string;
  name: string;
  cloneUrl: string;
}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          __typename: "ProjectV2",
          items: {
            nodes: [
              {
                id: "item-1",
                updatedAt: "2026-03-08T00:00:00.000Z",
                fieldValues: {
                  nodes: [
                    {
                      __typename: "ProjectV2ItemFieldSingleSelectValue",
                      name: "Todo",
                      field: {
                        name: "Status",
                      },
                    },
                  ],
                },
                content: {
                  __typename: "Issue",
                  id: "issue-1",
                  number: 1,
                  title: "Implement orchestrator",
                  body: null,
                  url: `https://example.test/${repository.owner}/${repository.name}/issues/1`,
                  createdAt: "2026-03-08T00:00:00.000Z",
                  updatedAt: "2026-03-08T00:00:00.000Z",
                  labels: {
                    nodes: [],
                  },
                  repository: {
                    name: repository.name,
                    url: `file://${repository.cloneUrl}`,
                    owner: {
                      login: repository.owner,
                    },
                  },
                },
              },
            ],
            pageInfo: {
              endCursor: null,
              hasNextPage: false,
            },
          },
        },
      },
    }),
  };
}

function createEmptyTrackerResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          __typename: "ProjectV2",
          items: {
            nodes: [],
            pageInfo: {
              endCursor: null,
              hasNextPage: false,
            },
          },
        },
      },
    }),
  };
}

async function createBareRepositoryFixture(
  root: string,
  owner: string,
  name: string
): Promise<{
  owner: string;
  name: string;
  cloneUrl: string;
  path: string;
}> {
  const repositoryRoot = join(root, `${owner}-${name}`);
  execSync(`mkdir -p ${shell(repositoryRoot)}`);
  execSync(`git init ${shell(repositoryRoot)}`, { stdio: "ignore" });
  execSync(
    `git -C ${shell(repositoryRoot)} config user.email tester@example.com`
  );
  execSync(`git -C ${shell(repositoryRoot)} config user.name tester`);
  await writeFile(join(repositoryRoot, "README.md"), "# bare repo\n", "utf8");
  execSync(`git -C ${shell(repositoryRoot)} add README.md`, {
    stdio: "ignore",
  });
  execSync(`git -C ${shell(repositoryRoot)} commit -m init`, {
    stdio: "ignore",
  });

  return {
    owner,
    name,
    cloneUrl: repositoryRoot,
    path: repositoryRoot,
  };
}

function createTrackerResponseWithState(
  repository: { owner: string; name: string; cloneUrl: string },
  state: string
) {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          __typename: "ProjectV2",
          items: {
            nodes: [
              {
                id: "item-1",
                updatedAt: "2026-03-08T00:00:00.000Z",
                fieldValues: {
                  nodes: [
                    {
                      __typename: "ProjectV2ItemFieldSingleSelectValue",
                      name: state,
                      field: {
                        name: "Status",
                      },
                    },
                  ],
                },
                content: {
                  __typename: "Issue",
                  id: "issue-1",
                  number: 1,
                  title: "Test issue",
                  body: null,
                  url: `https://example.test/${repository.owner}/${repository.name}/issues/1`,
                  createdAt: "2026-03-08T00:00:00.000Z",
                  updatedAt: "2026-03-08T00:00:00.000Z",
                  labels: {
                    nodes: [],
                  },
                  repository: {
                    name: repository.name,
                    url: `file://${repository.cloneUrl}`,
                    owner: {
                      login: repository.owner,
                    },
                  },
                },
              },
            ],
            pageInfo: {
              endCursor: null,
              hasNextPage: false,
            },
          },
        },
      },
    }),
  };
}

function shell(value: string): string {
  return JSON.stringify(value);
}

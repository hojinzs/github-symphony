import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveIssueWorkspaceKey,
  resolveIssueWorkspaceDirectory,
} from "@gh-symphony/core";
import { OrchestratorFsStore } from "./fs-store.js";
import * as gitModule from "./git.js";
import { OrchestratorService } from "./service.js";
import * as trackerAdapters from "./tracker-adapters.js";

describe("OrchestratorService", () => {
  const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;

  afterEach(() => {
    vi.restoreAllMocks();
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
          WORKSPACE_RUNTIME_DIR: expect.stringMatching(
            /projects\/tenant-1\/runs\/.+/
          ),
        }),
      })
    );
  });

  it("emits verbose lifecycle logs for dispatch, worker exit, retry scheduling, and completion", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-verbose-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const worker = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    worker.pid = 4102;
    worker.unref = vi.fn();
    const stderr = {
      write: vi.fn().mockReturnValue(true),
    };

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo")) as never,
      spawnImpl: vi.fn().mockReturnValue(worker) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
      stderr,
      logLevel: "verbose",
    });

    await service.runOnce();
    worker.emit("close", 0, null);
    await service.runOnce();

    const output = stderr.write.mock.calls
      .map((call) => String(call[0]))
      .join("");
    const run = (await store.loadAllRuns())[0];
    const runId = run?.runId;

    expect(runId).toBeTruthy();
    expect(output).toContain(`[dispatch] Issue acme/platform#1 → run ${runId}\n`);
    expect(output).toContain(`[worker-started] ${runId} (pid=4102)\n`);
    expect(output).toContain(
      `[worker-exited] ${runId} (code=0, signal=null)\n`
    );
    expect(output).toContain(
      `[retry-scheduled] ${runId} kind=continuation attempt=2 nextAt=2026-03-08T00:00:01.000Z\n`
    );
    expect(output).toContain(`[run-completed] ${runId} status=retrying\n`);
  });

  it("invokes onTick with the reconciliation snapshot when run() completes a tick", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-on-tick-"));
    try {
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(tempRoot, repository);
      await store.saveProjectConfig(projectConfig);

      const onTick = vi.fn();
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
        now: () => new Date("2026-03-08T00:00:00.000Z"),
        onTick,
      });

      await service.run({ once: true });

      expect(onTick).toHaveBeenCalledTimes(1);
      expect(onTick).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "tenant-1",
          slug: "tenant-1",
          health: "idle",
          lastTickAt: "2026-03-08T00:00:00.000Z",
          summary: expect.objectContaining({
            activeRuns: 0,
            dispatched: 0,
            suppressed: 0,
            recovered: 0,
          }),
        })
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("continues polling when onTick throws during long-running mode", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-on-tick-error-"));
    try {
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(tempRoot, repository);
      await store.saveProjectConfig(projectConfig);

      const stderr = {
        write: vi.fn().mockReturnValue(true),
      };
      let runningService: OrchestratorService | null = null;
      const onTick = vi
        .fn()
        .mockRejectedValueOnce(new Error("tick boom"))
        .mockImplementationOnce(async () => {
          await runningService?.shutdown();
        });
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
        now: () => new Date("2026-03-08T00:00:00.000Z"),
        waitImpl: vi.fn().mockResolvedValue(undefined),
        stderr,
        onTick,
      });
      runningService = service;

      await service.run();

      expect(onTick).toHaveBeenCalledTimes(2);
      expect(stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("[orchestrator] onTick callback failed: Error: tick boom")
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans up terminal issue workspaces during startup before the first tick", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-startup-cleanup-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");
    const sentinelPath = join(workspacePath, "sentinel.txt");

    await mkdir(repositoryPath, { recursive: true });
    await writeFile(sentinelPath, "cleanup me", "utf8");
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey,
        completedOnce: false,
        state: "released",
        currentRunId: null,
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveIssueWorkspace({
      workspaceKey,
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      workspacePath,
      repositoryPath,
      status: "active",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(createTrackerResponseWithState(repository, "Done"))
        .mockResolvedValueOnce(createTrackerResponse(repository)) as never,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4102,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.run({ once: true });

    const workspaceRecord = await store.loadIssueWorkspace("tenant-1", workspaceKey);
    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
    expect(workspaceRecord?.status).toBe("removed");
  });

  it("logs and ignores before_remove hook failures during startup cleanup", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-startup-before-remove-failure-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        rawWorkflow: `---
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
  before_remove: hooks/before_remove.sh
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");
    const sentinelPath = join(workspacePath, "sentinel.txt");

    await mkdir(repositoryPath, { recursive: true });
    await mkdir(join(repositoryPath, "hooks"), { recursive: true });
    await writeFile(
      join(repositoryPath, "hooks", "before_remove.sh"),
      "#!/usr/bin/env bash\nset -eu\nprintf 'cleanup hook failed' >&2\nexit 1\n",
      "utf8"
    );
    await writeFile(sentinelPath, "cleanup me", "utf8");
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey,
        completedOnce: false,
        state: "released",
        currentRunId: null,
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveIssueWorkspace({
      workspaceKey,
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      workspacePath,
      repositoryPath,
      status: "active",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(createTrackerResponseWithState(repository, "Done"))
        .mockResolvedValueOnce(createTrackerResponse(repository)) as never,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4103,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.run({ once: true });

    const workspaceRecord = await store.loadIssueWorkspace("tenant-1", workspaceKey);
    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
    expect(workspaceRecord?.status).toBe("removed");
    expect(workspaceRecord?.lastError).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[orchestrator] before_remove hook failed for acme/platform#1; continuing cleanup: cleanup hook failed"
    );
    warnSpy.mockRestore();
  });

  it("logs a warning and continues startup when terminal issue fetch fails", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-startup-warn-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");

    await mkdir(repositoryPath, { recursive: true });
    await store.saveIssueWorkspace({
      workspaceKey,
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      workspacePath,
      repositoryPath,
      status: "active",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4103,
      unref: vi.fn(),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockRejectedValueOnce(new Error("tracker unavailable"))
        .mockResolvedValueOnce(createTrackerResponse(repository)) as never,
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.run({ once: true });

    expect(warnSpy).toHaveBeenCalledWith(
      "[orchestrator] Startup cleanup skipped for project tenant-1: tracker unavailable"
    );
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("uses listIssuesByStates for startup cleanup terminal lookups", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-startup-list-issues-by-states-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");
    const sentinelPath = join(workspacePath, "sentinel.txt");

    await mkdir(repositoryPath, { recursive: true });
    await writeFile(sentinelPath, "cleanup me", "utf8");
    await store.saveIssueWorkspace({
      workspaceKey,
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      workspacePath,
      repositoryPath,
      status: "active",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    const listIssues = vi.fn(async () => {
      throw new Error("listIssues should not be used for startup cleanup");
    });
    const listIssuesByStates = vi.fn(async (_project, states: readonly string[]) => {
      expect(states).toEqual(["Done"]);
      return [
        {
          id: "issue-1",
          identifier: "acme/platform#1",
          number: 1,
          title: "Terminal issue",
          description: null,
          priority: null,
          state: "Done",
          branchName: null,
          url: "https://github.com/acme/platform/issues/1",
          labels: [],
          blockedBy: [],
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          repository,
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            itemId: "item-1",
          },
          metadata: {},
        },
      ];
    });
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates,
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4103,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.run({ once: true });

    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
    expect(listIssuesByStates).toHaveBeenCalledTimes(1);
    expect(listIssuesByStates).toHaveBeenCalledWith(
      projectConfig,
      ["Done"],
      expect.objectContaining({
        fetchImpl: expect.any(Function),
      })
    );
  });

  it("includes persisted workspace repositories when resolving startup cleanup terminal states", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-startup-workspace-terminal-states-")
    );
    const configuredRepository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const removedRepository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "legacy",
      {
        rawWorkflow: `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
  terminal_states:
    - Archived
  blocker_check_states:
    - Todo
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, configuredRepository);
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-legacy-1",
    });
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");
    const sentinelPath = join(workspacePath, "sentinel.txt");

    execSync(
      `git clone ${shell(removedRepository.cloneUrl)} ${shell(repositoryPath)}`,
      {
        stdio: "ignore",
      }
    );
    await writeFile(sentinelPath, "cleanup me", "utf8");
    await store.saveIssueWorkspace({
      workspaceKey,
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-legacy-1",
      issueIdentifier: "acme/legacy#1",
      workspacePath,
      repositoryPath,
      status: "active",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    const listIssuesByStates = vi.fn(
      async (_project, states: readonly string[]) => {
        expect([...states].sort()).toEqual(["Archived", "Done"]);
        return [
          {
            id: "issue-legacy-1",
            identifier: "acme/legacy#1",
            number: 1,
            title: "Archived issue",
            description: null,
            priority: null,
            state: "Archived",
            branchName: null,
            url: "https://github.com/acme/legacy/issues/1",
            labels: [],
            blockedBy: [],
            createdAt: "2026-03-08T00:00:00.000Z",
            updatedAt: "2026-03-08T00:00:00.000Z",
            repository: removedRepository,
            tracker: {
              adapter: "github-project",
              bindingId: "project-123",
              itemId: "item-legacy-1",
            },
            metadata: {},
          },
        ];
      }
    );
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues: vi.fn(),
      listIssuesByStates,
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4104,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.run({ once: true });

    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
    expect(listIssuesByStates).toHaveBeenCalledTimes(1);
  });

  it("reuses startup cleanup workflow resolution across terminal lookup and cleanup", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-startup-workflow-cache-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");

    await mkdir(repositoryPath, { recursive: true });
    await store.saveIssueWorkspace({
      workspaceKey,
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      workspacePath,
      repositoryPath,
      status: "active",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues: vi.fn(),
      listIssuesByStates: vi.fn(async () => [
        {
          id: "issue-1",
          identifier: "acme/platform#1",
          number: 1,
          title: "Terminal issue",
          description: null,
          priority: null,
          state: "Done",
          branchName: null,
          url: "https://github.com/acme/platform/issues/1",
          labels: [],
          blockedBy: [],
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          repository,
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            itemId: "item-1",
          },
          metadata: {},
        },
      ]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });
    const loadProjectWorkflowSpy = vi.spyOn(service as never, "loadProjectWorkflow");

    await (
      service as unknown as { performStartupCleanup: () => Promise<void> }
    ).performStartupCleanup();

    expect(loadProjectWorkflowSpy).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh per-tick project item cache between startup cleanup and reconciliation", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-project-item-cache-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const workspaceKey = deriveIssueWorkspaceKey({
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");

    await mkdir(repositoryPath, { recursive: true });
    await store.saveIssueWorkspace({
      workspaceKey,
      projectId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      workspacePath,
      repositoryPath,
      status: "active",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    let fetchCount = 0;
    const loadIssues = async () => {
      fetchCount += 1;
      return [
        {
          id: "issue-1",
          identifier: "acme/platform#1",
          number: 1,
          title: "Issue 1",
          description: null,
          priority: null,
          state: "Todo",
          branchName: null,
          url: "https://github.com/acme/platform/issues/1",
          labels: [],
          blockedBy: [],
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          repository,
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            itemId: "item-1",
          },
          metadata: {},
        },
      ];
    };

    const listIssues = vi.fn(async (_project, dependencies = {}) => {
      return dependencies.projectItemsCache?.getOrLoad("project-items", loadIssues);
    });
    const listIssuesByStates = vi.fn(async (_project, _states, dependencies = {}) => {
      const issues = await dependencies.projectItemsCache?.getOrLoad(
        "project-items",
        loadIssues
      );
      return issues ?? [];
    });
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates,
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4106,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.run({ once: true });

    expect(fetchCount).toBe(2);
    expect(listIssuesByStates).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssuesByStates.mock.calls[0]?.[2]?.projectItemsCache).not.toBe(
      listIssues.mock.calls[0]?.[1]?.projectItemsCache
    );
  });

  it("creates a fresh per-tick project item cache for each runOnce call", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-project-item-cache-per-runonce-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    let fetchCount = 0;
    const cacheInstances = new Set<unknown>();
    const listIssues = vi.fn(async (_project, dependencies = {}) => {
      cacheInstances.add(dependencies.projectItemsCache);
      return dependencies.projectItemsCache?.getOrLoad("project-items", async () => {
        fetchCount += 1;
        return [];
      });
    });
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    await service.runOnce();

    expect(fetchCount).toBe(2);
    expect(cacheInstances.size).toBe(2);
  });

  it("serializes startup cleanup with concurrent runOnce calls", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-startup-lock-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const events: string[] = [];
    let releaseStartupCleanup: (() => void) | null = null;
    const startupCleanupGate = new Promise<void>((resolve) => {
      releaseStartupCleanup = resolve;
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4105,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });
    vi.spyOn(service as never, "performStartupCleanup").mockImplementation(
      async () => {
        events.push("startup-begin");
        await startupCleanupGate;
        events.push("startup-end");
      }
    );

    const runPromise = service.run({ once: true }).then(() => {
      events.push("run");
    });
    await Promise.resolve();
    const manualRunOncePromise = service.runOnce().then(() => {
      events.push("manual-runOnce");
    });
    await Promise.resolve();

    expect(events).toEqual(["startup-begin"]);

    releaseStartupCleanup?.();
    await Promise.all([runPromise, manualRunOncePromise]);

    expect(events.indexOf("startup-end")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("manual-runOnce")).toBeGreaterThan(
      events.indexOf("startup-end")
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
        completedOnce: false,
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
      issueTitle: "Persisted issue title",
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
    const listIssues = vi.fn().mockResolvedValue([]);
    const fetchIssueStatesByIds = vi.fn().mockResolvedValue([
      {
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Test issue",
        description: null,
        priority: null,
        state: "Todo",
        branchName: null,
        url: "https://github.com/acme/platform/issues/1",
        labels: [],
        blockedBy: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          itemId: "item-1",
        },
        metadata: {},
      },
    ]);
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds,
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn().mockReturnValue({
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Test issue",
        description: null,
        priority: null,
        state: "Todo",
        branchName: null,
        url: "https://github.com/acme/platform/issues/1",
        labels: [],
        blockedBy: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          itemId: "item-1",
        },
        metadata: {},
      }),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      } as Response) as never,
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:01:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.recovered).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "node packages/worker/dist/index.js"],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_STATE: "Todo",
          SYMPHONY_ISSUE_TITLE: "Test issue",
        }),
      })
    );
    expect(fetchIssueStatesByIds).toHaveBeenCalledWith(
      projectConfig,
      ["issue-1"],
      expect.objectContaining({
        fetchImpl: expect.any(Function),
      })
    );

    const runs = await store.loadAllRuns();
    const recoveredRun = runs.find((run) => run.runId !== "run-1");

    expect(recoveredRun?.issueTitle).toBe("Test issue");
    expect(recoveredRun?.issueState).toBe("Todo");
  });

  it("releases due retrying runs when the tracker issue is missing", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-retry-release-")
    );
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
        completedOnce: false,
        state: "retry_queued",
        currentRunId: "run-1",
        retryEntry: {
          attempt: 2,
          dueAt: "2026-03-08T00:00:20.000Z",
          error: "Worker process exited unexpectedly.",
        },
        updatedAt: "2026-03-08T00:00:10.000Z",
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
      issueWorkspaceKey: "acme_platform_1",
      workspaceRuntimeDir: join(tempRoot, "stale-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: "failure",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:10.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: "Worker process exited unexpectedly.",
      nextRetryAt: "2026-03-08T00:00:20.000Z",
      runPhase: "failed",
    });

    const spawnImpl = vi.fn();
    const listIssues = vi.fn();
    const fetchIssueStatesByIds = vi.fn().mockResolvedValue([]);
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds,
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      } as Response) as never,
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:01:00.000Z"),
    });

    const result = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");
    const issueRecords = await store.loadProjectIssueOrchestrations("tenant-1");

    expect(result.summary.recovered).toBe(0);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fetchIssueStatesByIds).toHaveBeenCalledWith(
      projectConfig,
      ["issue-1"],
      expect.objectContaining({
        fetchImpl: expect.any(Function),
      })
    );
    expect(fetchIssueStatesByIds.mock.invocationCallOrder[0]).toBeLessThan(
      listIssues.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(updatedRun?.status).toBe("suppressed");
    expect(updatedRun?.nextRetryAt).toBeNull();
    expect(updatedRun?.runPhase).toBe("canceled_by_reconciliation");
    expect(updatedRun?.lastError).toBe(
      "Retry canceled because the tracker issue is no longer actionable."
    );
    expect(issueRecords[0]).toMatchObject({
      issueId: "issue-1",
      completedOnce: false,
      state: "released",
      currentRunId: null,
      retryEntry: null,
    });
  });

  it("keeps restarting due retrying runs when tracker eligibility cannot be confirmed", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-retry-transient-")
    );
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
        completedOnce: false,
        state: "retry_queued",
        currentRunId: "run-1",
        retryEntry: {
          attempt: 2,
          dueAt: "2026-03-08T00:00:20.000Z",
          error: "Worker process exited unexpectedly.",
        },
        updatedAt: "2026-03-08T00:00:10.000Z",
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
      issueWorkspaceKey: "acme_platform_1",
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
      pid: 4103,
      unref: vi.fn(),
    });
    const listIssues = vi.fn();
    const fetchIssueStatesByIds = vi
      .fn()
      .mockRejectedValue(new Error("tracker unavailable"));
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds,
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn().mockReturnValue({
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Test issue",
        description: null,
        priority: null,
        state: "Todo",
        branchName: null,
        url: "https://github.com/acme/platform/issues/1",
        labels: [],
        blockedBy: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          itemId: "item-1",
        },
        metadata: {},
      }),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      } as Response) as never,
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:01:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.recovered).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(fetchIssueStatesByIds).toHaveBeenCalledWith(
      projectConfig,
      ["issue-1"],
      expect.objectContaining({
        fetchImpl: expect.any(Function),
      })
    );
    expect(listIssues).not.toHaveBeenCalled();
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
        completedOnce: false,
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
            path: join(store.runDir("run-1", "tenant-1"), "worker.log"),
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
        completedOnce: false,
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

  it("reloads workflow concurrency limits for future dispatches without restart", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-concurrency-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        maxConcurrentAgents: 1,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4301,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(
        createTrackerResponseWithItems(repository, [
          { id: "issue-1", identifier: "acme/platform#1", state: "Todo" },
          { id: "issue-2", identifier: "acme/platform#2", state: "Todo" },
        ])
      ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const first = await service.runOnce();
    expect(first.summary.dispatched).toBe(1);

    await commitWorkflowFixture(repository.path, {
      maxConcurrentAgents: 2,
    });

    const second = await service.runOnce();
    expect(second.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it("respects an explicit workflow concurrency of zero", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-concurrency-0-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        maxConcurrentAgents: 0,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4305,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(
        createTrackerResponseWithItems(repository, [
          { id: "issue-1", identifier: "acme/platform#1", state: "Todo" },
        ])
      ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(0);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("keeps the last known good workflow when a reload becomes invalid", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-workflow-lkg-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        schedulerPollIntervalMs: 5000,
        maxConcurrentAgents: 2,
        codexCommand: "codex --model gpt-5",
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4302,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(createEmptyTrackerResponse())
        .mockResolvedValueOnce(
          createTrackerResponseWithItems(repository, [
            { id: "issue-1", identifier: "acme/platform#1", state: "Todo" },
          ])
        ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    expect(service.getEffectivePollIntervalMs()).toBe(5000);

    await commitWorkflowFixture(repository.path, {
      rawWorkflow: "---\ninvalid: [\n---\n",
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(service.getEffectivePollIntervalMs()).toBe(5000);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("packages/worker/dist/index.js")],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_AGENT_COMMAND: "codex --model gpt-5",
        }),
      })
    );
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("failed to reload WORKFLOW.md")
    );
  });

  it("keeps a readable workflow snapshot when WORKFLOW.md is deleted", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-workflow-missing-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        codexCommand: "codex --model gpt-5",
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4306,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(createEmptyTrackerResponse())
        .mockResolvedValueOnce(
          createTrackerResponseWithItems(repository, [
            { id: "issue-1", identifier: "acme/platform#1", state: "Todo" },
          ])
        ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();

    execSync(`git -C ${shell(repository.path)} rm WORKFLOW.md`, {
      stdio: "ignore",
    });
    execSync(`git -C ${shell(repository.path)} commit -m remove-workflow`, {
      stdio: "ignore",
    });

    const result = await service.runOnce();
    const workerEnv = spawnImpl.mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;

    expect(result.summary.dispatched).toBe(1);
    expect(workerEnv?.SYMPHONY_AGENT_COMMAND).toBe("codex --model gpt-5");
    expect(workerEnv?.SYMPHONY_WORKFLOW_PATH).toBe(
      join(
        store.projectDir(projectConfig.projectId),
        "cache",
        repository.owner,
        repository.name,
        "last-known-good",
        "WORKFLOW.md"
      )
    );
    await expect(
      readFile(workerEnv?.SYMPHONY_WORKFLOW_PATH ?? "", "utf8")
    ).resolves.toContain("codex --model gpt-5");
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("failed to reload WORKFLOW.md")
    );
  });

  it("reuses a single workflow sync per repository within one tick", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-workflow-cache-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const syncSpy = vi.spyOn(gitModule, "syncRepositoryForRun");
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(
        createTrackerResponseWithItems(repository, [
          { id: "issue-1", identifier: "acme/platform#1", state: "Todo" },
        ])
      ),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4307,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();

    const workflowSyncCalls = syncSpy.mock.calls.filter(
      ([input]) =>
        typeof input === "object" &&
        input !== null &&
        "targetDirectory" in input &&
        String(input.targetDirectory).includes("/cache/")
    );

    expect(workflowSyncCalls).toHaveLength(1);
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
        completedOnce: false,
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

  it("keeps scheduling retries after the third failed attempt", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-unbounded-retry-")
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
        completedOnce: false,
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
      attempt: 3,
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

    const fetchImpl = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/state")) {
        return Promise.resolve({
          ok: false,
          json: vi.fn(),
        } as Response);
      }
      return Promise.resolve(createEmptyTrackerResponse());
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4105,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const updatedRun = await store.loadRun("run-1");
    const issueRecords = await store.loadProjectIssueOrchestrations("tenant-1");

    expect(updatedRun?.status).toBe("retrying");
    expect(updatedRun?.attempt).toBe(4);
    expect(updatedRun?.nextRetryAt).toBe("2026-03-08T00:00:07.000Z");
    expect(issueRecords[0]?.state).toBe("retry_queued");
    expect(issueRecords[0]?.retryEntry).toEqual({
      attempt: 4,
      dueAt: "2026-03-08T00:00:07.000Z",
      error: "Worker process exited unexpectedly.",
    });
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
        completedOnce: false,
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
    const issueRecords = await store.loadProjectIssueOrchestrations("tenant-1");

    expect(updatedRun?.status).toBe("retrying");
    expect(updatedRun?.nextRetryAt).toBe("2026-03-08T00:00:01.000Z");
    expect(updatedRun?.retryKind).toBe("continuation");
    expect(updatedRun?.lastError).toBeNull();
    expect(issueRecords[0]?.completedOnce).toBe(true);
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
        completedOnce: false,
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

  it("formats stall detection as a structured verbose log when enabled", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-stall-log-"));
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
        completedOnce: false,
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

    const stderr = {
      write: vi.fn().mockReturnValue(true),
    };
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/state")) {
          throw new Error("worker shutting down");
        }
        return createTrackerResponseWithState(repository, "In Progress");
      }) as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4206,
        unref: vi.fn(),
      }) as never,
      killImpl: vi.fn(),
      isProcessRunning: (pid) => pid === 4106,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
      stderr,
      logLevel: "verbose",
    });

    await service.runOnce();

    expect(stderr.write).toHaveBeenCalledWith(
      "[stall-detected] run-1 (elapsed=180s > 120s)\n"
    );
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
        completedOnce: false,
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
      runtimeSession: {
        sessionId: "thread-1-turn-xyz",
        threadId: "thread-1",
        status: "active",
        startedAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:04:00.000Z",
        exitClassification: null,
      },
    });

    const killImpl = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(createTrackerResponseWithState(repository, "Todo"));
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
    expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:00.000Z");
    expect(updatedRun?.runtimeSession?.sessionId).toBe("thread-1-turn-xyz");
  });

  it("preserves the persisted lastEventAt when live worker state omits timestamps", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stall-preserve-")
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
        completedOnce: false,
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
      processId: 4109,
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
    let currentTime = new Date("2026-03-08T00:06:00.000Z");
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4209,
        unref: vi.fn(),
      }) as never,
      killImpl,
      isProcessRunning: (pid) => pid === 4109,
      now: () => currentTime,
    });

    await service.runOnce();

    currentTime = new Date("2026-03-08T00:08:00.000Z");
    await service.runOnce();

    const updatedRun = await store.loadRun("run-1");

    expect(killImpl).not.toHaveBeenCalled();
    expect(updatedRun?.status).toBe("running");
    expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:00.000Z");
  });

  it("ignores worker state API lastEventAt and keeps the persisted event-channel timestamp", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stall-ignore-api-timestamp-")
    );
    try {
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
          completedOnce: false,
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
        processId: 4110,
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
        lastEventAtSource: "event-channel",
        runtimeSession: {
          sessionId: "thread-1-turn-xyz",
          threadId: "thread-1",
          status: "active",
          startedAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:04:00.000Z",
          exitClassification: null,
        },
      });

      const killImpl = vi.fn();
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo"));
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: fetchImpl as typeof fetch,
        spawnImpl: vi.fn().mockReturnValue({
          pid: 4210,
          unref: vi.fn(),
        }) as never,
        killImpl,
        isProcessRunning: (pid) => pid === 4110,
        now: () => new Date("2026-03-08T00:06:00.000Z"),
      });

      await service.runOnce();

      const updatedRun = await store.loadRun("run-1");

      expect(killImpl).not.toHaveBeenCalled();
      expect(updatedRun?.status).toBe("running");
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:00.000Z");
      expect(updatedRun?.lastEventAtSource).toBe("event-channel");
      expect(updatedRun?.runtimeSession?.sessionId).toBe("thread-1-turn-xyz");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not move a persisted lastEventAt backwards when a legacy worker reports an older API timestamp", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stall-monotonic-legacy-")
    );
    try {
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
          completedOnce: false,
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
        processId: 4112,
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
              lastEventAt: "2026-03-08T00:03:30.000Z",
              sessionInfo: {
                threadId: "thread-legacy",
                turnId: "turn-1",
                turnCount: 1,
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
          pid: 4212,
          unref: vi.fn(),
        }) as never,
        killImpl,
        isProcessRunning: (pid) => pid === 4112,
        now: () => new Date("2026-03-08T00:06:00.000Z"),
      });

      await service.runOnce();

      const updatedRun = await store.loadRun("run-1");

      expect(killImpl).not.toHaveBeenCalled();
      expect(updatedRun?.status).toBe("running");
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:00.000Z");
      expect(updatedRun?.lastEventAtSource).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to startedAt for stall detection when no event-channel timestamp has been persisted yet", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stall-api-fallback-")
    );
    try {
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
          completedOnce: false,
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
        processId: 4111,
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
        lastEventAt: null,
      });

      const killImpl = vi.fn();
      let currentTime = new Date("2026-03-08T00:04:00.000Z");
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo"));
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: fetchImpl as typeof fetch,
        spawnImpl: vi.fn().mockReturnValue({
          pid: 4211,
          unref: vi.fn(),
        }) as never,
        killImpl,
        isProcessRunning: (pid) => pid === 4111,
        now: () => currentTime,
      });

      await service.runOnce();
      currentTime = new Date("2026-03-08T00:09:00.000Z");
      await service.runOnce();

      const updatedRun = await store.loadRun("run-1");

      expect(killImpl).toHaveBeenCalledWith(4111, "SIGTERM");
      expect(updatedRun?.status).toBe("retrying");
      expect(updatedRun?.lastEventAt).toBeUndefined();
      expect(updatedRun?.lastEventAtSource).toBeUndefined();
      expect(updatedRun?.runtimeSession?.threadId).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the persisted event-channel timestamp when collecting final worker info after exit", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stall-final-info-event-channel-")
    );
    try {
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
          completedOnce: false,
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
        processId: 4113,
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
        lastEventAtSource: "event-channel",
        runtimeSession: {
          sessionId: "thread-1-turn-final",
          threadId: "thread-1",
          status: "active",
          startedAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:04:00.000Z",
          exitClassification: null,
        },
      });

      const fetchImpl = vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo"));
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: fetchImpl as typeof fetch,
        spawnImpl: vi.fn().mockReturnValue({
          pid: 4213,
          unref: vi.fn(),
        }) as never,
        isProcessRunning: () => false,
        now: () => new Date("2026-03-08T00:06:00.000Z"),
      });

      await service.runOnce();

      const updatedRun = await store.loadRun("run-1");

      expect(updatedRun?.status).toBe("retrying");
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:00.000Z");
      expect(updatedRun?.lastEventAtSource).toBe("event-channel");
      expect(updatedRun?.runtimeSession?.sessionId).toBe("thread-1-turn-final");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates lastEventAt from worker stderr events even when the worker state API is unavailable", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-stderr-channel-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        stallTimeoutMs: 120000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const worker = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: PassThrough;
      unref: ReturnType<typeof vi.fn>;
    };
    worker.pid = 4110;
    worker.stderr = new PassThrough();
    worker.unref = vi.fn();

    const killImpl = vi.fn();
    let currentTime = new Date("2026-03-08T00:00:00.000Z");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        throw new Error("worker state API unavailable");
      }
      return createTrackerResponseWithState(repository, "Todo");
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue(worker) as never,
      killImpl,
      isProcessRunning: (pid) => pid === 4110,
      now: () => currentTime,
    });

    await service.runOnce();
    const initialRun = (await store.loadAllRuns())[0];
    expect(initialRun).toBeTruthy();

    worker.stderr.write(
      `[worker] codex → thread/tokenUsage/updated {"input_tokens":12}\n${JSON.stringify({
        type: "codex_update",
        issueId: initialRun!.issueId,
        lastEventAt: "2026-03-08T00:04:30.000Z",
        tokenUsage: {
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 17,
        },
        rateLimits: {
          source: "codex",
          remaining: 3,
        },
        event: "thread/tokenUsage/updated",
      })}\n`
    );

    await vi.waitFor(async () => {
      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:30.000Z");
    });

    currentTime = new Date("2026-03-08T00:06:00.000Z");
    await service.runOnce();

    const updatedRun = await store.loadRun(initialRun!.runId);

    expect(killImpl).not.toHaveBeenCalled();
    expect(updatedRun?.status).toBe("running");
    expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:30.000Z");
    expect(updatedRun?.tokenUsage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
    });
    expect(updatedRun?.rateLimits).toEqual({
      source: "codex",
      remaining: 3,
    });
    expect(updatedRun?.updatedAt).toBe("2026-03-08T00:06:00.000Z");
  });

  it("applies queued codex_update metadata after the run transitions to retrying", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-retrying-channel-update-")
    );
    try {
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
          completedOnce: false,
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
        processId: 4601,
        port: null,
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

      const fetchIssueStatesByIds = vi.fn().mockImplementation(async () => {
        (
          service as unknown as {
            consumeWorkerStderrLine(runId: string, line: string): void;
          }
        ).consumeWorkerStderrLine(
          "run-1",
          JSON.stringify({
            type: "codex_update",
            issueId: "issue-1",
            event: "turn/failed",
            lastEventAt: "2026-03-08T00:05:30.000Z",
            tokenUsage: {
              inputTokens: 21,
              outputTokens: 8,
              totalTokens: 29,
            },
            sessionInfo: {
              threadId: "thread-1",
              turnId: "turn-final",
              turnCount: 2,
              sessionId: "thread-1-turn-final",
            },
            executionPhase: "implementation",
            runPhase: "failed",
            lastError: "turn failed",
          })
        );
        return [
          {
            id: "issue-1",
            identifier: "acme/platform#1",
            number: 1,
            title: "Test issue",
            description: null,
            priority: null,
            state: "Todo",
            branchName: null,
            url: "https://github.com/acme/platform/issues/1",
            labels: [],
            blockedBy: [],
            createdAt: "2026-03-08T00:00:00.000Z",
            updatedAt: "2026-03-08T00:05:00.000Z",
            repository,
            tracker: {
              adapter: "github-project" as const,
              bindingId: "project-123",
              itemId: "item-1",
            },
            metadata: {},
          },
        ];
      });
      vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
        listIssues: vi.fn().mockResolvedValue([
          {
            id: "issue-1",
            identifier: "acme/platform#1",
            number: 1,
            title: "Test issue",
            description: null,
            priority: null,
            state: "Todo",
            branchName: null,
            url: "https://github.com/acme/platform/issues/1",
            labels: [],
            blockedBy: [],
            createdAt: "2026-03-08T00:00:00.000Z",
            updatedAt: "2026-03-08T00:05:00.000Z",
            repository,
            tracker: {
              adapter: "github-project" as const,
              bindingId: "project-123",
              itemId: "item-1",
            },
            metadata: {},
          },
        ]),
        listIssuesByStates: vi.fn().mockResolvedValue([]),
        fetchIssueStatesByIds,
        buildWorkerEnvironment: vi.fn().mockReturnValue({
          GITHUB_PROJECT_ID: "project-123",
        }),
        reviveIssue: vi.fn(),
      });

      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()) as never,
        isProcessRunning: () => false,
        now: () => new Date("2026-03-08T00:06:00.000Z"),
      });

      await service.runOnce();

      await vi.waitFor(async () => {
        const updatedRun = await store.loadRun("run-1");
        expect(updatedRun?.status).toBe("retrying");
        expect(updatedRun?.updatedAt).toBe("2026-03-08T00:06:00.000Z");
        expect(updatedRun?.runtimeSession?.sessionId).toBe(
          "thread-1-turn-final"
        );
        expect(updatedRun?.runtimeSession?.updatedAt).toBe(
          "2026-03-08T00:06:00.000Z"
        );
        expect(updatedRun?.executionPhase).toBe("implementation");
        expect(updatedRun?.runPhase).toBe("failed");
        expect(updatedRun?.lastError).toBe("turn failed");
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies heartbeat payloads as full runtime snapshots", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-heartbeat-"));
    try {
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform",
        {
          stallTimeoutMs: 120000,
        }
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(tempRoot, repository);
      await store.saveProjectConfig(projectConfig);

      const worker = new EventEmitter() as EventEmitter & {
        pid: number;
        stderr: PassThrough;
        unref: ReturnType<typeof vi.fn>;
      };
      worker.pid = 4114;
      worker.stderr = new PassThrough();
      worker.unref = vi.fn();

      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi
          .fn()
          .mockResolvedValue(
            createTrackerResponseWithState(repository, "Todo")
          ) as never,
        spawnImpl: vi.fn().mockReturnValue(worker) as never,
        isProcessRunning: (pid) => pid === 4114,
        now: () => new Date("2026-03-08T00:06:00.000Z"),
      });

      await service.runOnce();
      const initialRun = (await store.loadAllRuns())[0];
      expect(initialRun).toBeTruthy();

      worker.stderr.write(
        `${JSON.stringify({
          type: "heartbeat",
          issueId: initialRun!.issueId,
          lastEventAt: "2026-03-08T00:04:30.000Z",
          tokenUsage: {
            inputTokens: 22,
            outputTokens: 8,
            totalTokens: 30,
          },
          rateLimits: null,
          sessionInfo: {
            threadId: "thread-1",
            turnId: "turn-xyz",
            turnCount: 2,
            sessionId: "thread-1-turn-xyz",
          },
          executionPhase: "human-review",
          runPhase: "failed",
          lastError: "turn_input_required: agent requires user input",
        })}\n`
      );

      await vi.waitFor(async () => {
        const updatedRun = await store.loadRun(initialRun!.runId);
        expect(updatedRun?.lastEvent).toBe("heartbeat");
      });

      const updatedRun = await store.loadRun(initialRun!.runId);

      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:04:30.000Z");
      expect(updatedRun?.lastEventAtSource).toBe("event-channel");
      expect(updatedRun?.tokenUsage).toEqual({
        inputTokens: 22,
        outputTokens: 8,
        totalTokens: 30,
      });
      expect(updatedRun?.rateLimits).toBeNull();
      expect(updatedRun?.runtimeSession?.sessionId).toBe("thread-1-turn-xyz");
      expect(updatedRun?.runtimeSession?.threadId).toBe("thread-1");
      expect(updatedRun?.turnCount).toBe(2);
      expect(updatedRun?.executionPhase).toBe("human-review");
      expect(updatedRun?.runPhase).toBe("failed");
      expect(updatedRun?.lastError).toBe(
        "turn_input_required: agent requires user input"
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves prior activity metadata when a heartbeat omits it", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-heartbeat-preserve-")
    );
    try {
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(tempRoot, repository);
      await store.saveProjectConfig(projectConfig);

      const worker = new EventEmitter() as EventEmitter & {
        pid: number;
        stderr: PassThrough;
        unref: ReturnType<typeof vi.fn>;
      };
      worker.pid = 4115;
      worker.stderr = new PassThrough();
      worker.unref = vi.fn();

      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi
          .fn()
          .mockResolvedValue(
            createTrackerResponseWithState(repository, "Todo")
          ) as never,
        spawnImpl: vi.fn().mockReturnValue(worker) as never,
        isProcessRunning: (pid) => pid === 4115,
        now: () => new Date("2026-03-08T00:07:00.000Z"),
      });

      await service.runOnce();
      const initialRun = (await store.loadAllRuns())[0];
      expect(initialRun).toBeTruthy();

      await store.saveRun({
        ...initialRun!,
        lastEventAt: "2026-03-08T00:06:30.000Z",
        lastEventAtSource: "event-channel",
        turnCount: 3,
        executionPhase: "implementation",
        runPhase: "streaming_turn",
        lastError: "previous error",
      });

      worker.stderr.write(
        `${JSON.stringify({
          type: "heartbeat",
          issueId: initialRun!.issueId,
          lastEventAt: null,
          tokenUsage: {
            inputTokens: 30,
            outputTokens: 12,
            totalTokens: 42,
          },
          rateLimits: null,
          sessionInfo: null,
          executionPhase: null,
          runPhase: null,
          lastError: null,
        })}\n`
      );

      await vi.waitFor(async () => {
        const updatedRun = await store.loadRun(initialRun!.runId);
        expect(updatedRun?.lastEvent).toBe("heartbeat");
        expect(updatedRun?.tokenUsage).toEqual({
          inputTokens: 30,
          outputTokens: 12,
          totalTokens: 42,
        });
      });

      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:06:30.000Z");
      expect(updatedRun?.lastEventAtSource).toBe("event-channel");
      expect(updatedRun?.turnCount).toBe(3);
      expect(updatedRun?.executionPhase).toBe("implementation");
      expect(updatedRun?.runPhase).toBe("streaming_turn");
      expect(updatedRun?.lastError).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("flushes a trailing codex_update line when worker stderr closes without a newline", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stderr-close-flush-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        stallTimeoutMs: 120000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const worker = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: PassThrough;
      unref: ReturnType<typeof vi.fn>;
    };
    worker.pid = 4111;
    worker.stderr = new PassThrough();
    worker.unref = vi.fn();

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo")) as never,
      spawnImpl: vi.fn().mockReturnValue(worker) as never,
      isProcessRunning: (pid) => pid === 4111,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const initialRun = (await store.loadAllRuns())[0];
    expect(initialRun).toBeTruthy();

    worker.stderr.write(
      JSON.stringify({
        type: "codex_update",
        issueId: initialRun!.issueId,
        lastEventAt: "2026-03-08T00:01:30.000Z",
        event: "thread/updated",
      })
    );
    worker.stderr.end();
    worker.emit("close", 0, null);

    await vi.waitFor(async () => {
      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:01:30.000Z");
    });

    const workerLog = await readFile(
      join(store.runDir(initialRun!.runId, "tenant-1"), "worker.log"),
      "utf8"
    );
    expect(workerLog).toContain('"lastEventAt":"2026-03-08T00:01:30.000Z"');

    worker.stderr.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "codex_update",
          issueId: initialRun!.issueId,
          lastEventAt: "2026-03-08T00:02:00.000Z",
        })}\n`
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updatedRun = await store.loadRun(initialRun!.runId);
    expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:01:30.000Z");
  });

  it("parses codex_update lines when UTF-8 multi-byte characters are split across stderr chunks", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-stderr-utf8-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        stallTimeoutMs: 120000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const worker = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: PassThrough;
      unref: ReturnType<typeof vi.fn>;
    };
    worker.pid = 41115;
    worker.stderr = new PassThrough();
    worker.unref = vi.fn();

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo")) as never,
      spawnImpl: vi.fn().mockReturnValue(worker) as never,
      isProcessRunning: (pid) => pid === 41115,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const initialRun = (await store.loadAllRuns())[0];
    expect(initialRun).toBeTruthy();

    const encodedEvent = Buffer.from(
      `${JSON.stringify({
        type: "codex_update",
        issueId: initialRun!.issueId,
        lastEventAt: "2026-03-08T00:02:30.000Z",
        rateLimits: {
          source: "codex",
          label: "한도",
        },
      })}\n`,
      "utf8"
    );
    const splitIndex = encodedEvent.indexOf(Buffer.from("한", "utf8"));
    expect(splitIndex).toBeGreaterThan(0);

    worker.stderr.write(encodedEvent.subarray(0, splitIndex + 1));
    worker.stderr.write(encodedEvent.subarray(splitIndex + 1));

    await vi.waitFor(async () => {
      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:02:30.000Z");
      expect(updatedRun?.rateLimits).toEqual({
        source: "codex",
        label: "한도",
      });
    });
  });

  it("skips JSON.parse for plain worker stderr log lines", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-stderr-fast-path-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        stallTimeoutMs: 120000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const worker = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: PassThrough;
      unref: ReturnType<typeof vi.fn>;
    };
    worker.pid = 4112;
    worker.stderr = new PassThrough();
    worker.unref = vi.fn();

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo")) as never,
      spawnImpl: vi.fn().mockReturnValue(worker) as never,
      isProcessRunning: (pid) => pid === 4112,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const initialRun = (await store.loadAllRuns())[0];
    expect(initialRun).toBeTruthy();

    const parseSpy = vi.spyOn(JSON, "parse");
    worker.stderr.write(
      `[worker] codex → thread/tokenUsage/updated {"input_tokens":12}\n${JSON.stringify({
        type: "codex_update",
        issueId: initialRun!.issueId,
        lastEventAt: "2026-03-08T00:03:00.000Z",
      })}\n`
    );

    await vi.waitFor(async () => {
      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:03:00.000Z");
    });

    expect(parseSpy).toHaveBeenCalledWith(
      expect.stringContaining('"type":"codex_update"')
    );
    expect(
      parseSpy.mock.calls.some(
        ([input]) =>
          String(input).startsWith("[worker] codex → thread/tokenUsage/updated")
      )
    ).toBe(false);
  });

  it("pauses worker stderr until worker.log drain clears backpressure", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stderr-backpressure-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        stallTimeoutMs: 120000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const worker = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: PassThrough;
      unref: ReturnType<typeof vi.fn>;
    };
    worker.pid = 4113;
    worker.stderr = new PassThrough();
    worker.unref = vi.fn();

    const pauseSpy = vi.spyOn(worker.stderr, "pause");
    const resumeSpy = vi.spyOn(worker.stderr, "resume");
    const workerLogStream = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    workerLogStream.write = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    workerLogStream.end = vi.fn();

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo")) as never,
      spawnImpl: vi.fn().mockReturnValue(worker) as never,
      createWriteStreamImpl: vi
        .fn()
        .mockReturnValue(workerLogStream) as never,
      isProcessRunning: (pid) => pid === 4113,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const initialRun = (await store.loadAllRuns())[0];
    expect(initialRun).toBeTruthy();

    worker.stderr.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "codex_update",
          issueId: initialRun!.issueId,
          lastEventAt: "2026-03-08T00:05:00.000Z",
        })}\n`
      )
    );

    await vi.waitFor(async () => {
      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:05:00.000Z");
    });

    expect(workerLogStream.write).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    const resumeCallsBeforeDrain = resumeSpy.mock.calls.length;

    workerLogStream.emit("drain");

    expect(resumeSpy.mock.calls.length).toBeGreaterThan(resumeCallsBeforeDrain);

    worker.stderr.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "codex_update",
          issueId: initialRun!.issueId,
          lastEventAt: "2026-03-08T00:05:30.000Z",
        })}\n`
      )
    );

    await vi.waitFor(async () => {
      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:05:30.000Z");
    });

    expect(workerLogStream.write).toHaveBeenCalledTimes(2);
  });

  it("drains paused worker stderr before finalize flushes trailing codex updates", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-stderr-finalize-drain-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        stallTimeoutMs: 120000,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const stderr = new EventEmitter() as EventEmitter & {
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      read: ReturnType<typeof vi.fn>;
      readable: boolean;
      readableEnded: boolean;
    };
    stderr.pause = vi.fn();
    stderr.resume = vi.fn();
    stderr.read = vi.fn().mockReturnValue(null);
    stderr.readable = true;
    stderr.readableEnded = false;

    const worker = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: typeof stderr;
      unref: ReturnType<typeof vi.fn>;
    };
    worker.pid = 4114;
    worker.stderr = stderr;
    worker.unref = vi.fn();

    const workerLogStream = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    workerLogStream.write = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    workerLogStream.end = vi.fn();

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponseWithState(repository, "Todo")) as never,
      spawnImpl: vi.fn().mockReturnValue(worker) as never,
      createWriteStreamImpl: vi
        .fn()
        .mockReturnValue(workerLogStream) as never,
      isProcessRunning: (pid) => pid === 4114,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();
    const initialRun = (await store.loadAllRuns())[0];
    expect(initialRun).toBeTruthy();

    worker.stderr.emit("data", Buffer.from("[worker] backpressure\n"));
    worker.stderr.readableEnded = true;
    worker.stderr.read
      .mockReturnValueOnce(
        Buffer.from(
          JSON.stringify({
            type: "codex_update",
            issueId: initialRun!.issueId,
            lastEventAt: "2026-03-08T00:06:00.000Z",
          })
        )
      )
      .mockReturnValueOnce(null);
    worker.emit("close", 0, null);

    await vi.waitFor(async () => {
      const updatedRun = await store.loadRun(initialRun!.runId);
      expect(updatedRun?.lastEventAt).toBe("2026-03-08T00:06:00.000Z");
    });

    expect(workerLogStream.write).toHaveBeenCalledTimes(2);
    expect(workerLogStream.write.mock.calls[1]?.[0].toString("utf8")).toContain(
      '"lastEventAt":"2026-03-08T00:06:00.000Z"'
    );
    expect(workerLogStream.end).toHaveBeenCalledTimes(1);
  });

  it("propagates worker rate-limit payloads into persisted runs and project snapshots", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-rate-limits-"));
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
        completedOnce: false,
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
      processId: 4110,
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
      rateLimits: {
        source: "codex",
        remaining: 42,
        resetAt: "2026-03-08T00:30:00.000Z",
      },
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(createTrackerResponseWithState(repository, "Todo"));
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4210,
        unref: vi.fn(),
      }) as never,
      isProcessRunning: (pid) => pid === 4110,
      now: () => new Date("2026-03-08T00:06:00.000Z"),
    });

    const snapshot = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(updatedRun?.rateLimits).toEqual({
      source: "codex",
      remaining: 42,
      resetAt: "2026-03-08T00:30:00.000Z",
    });
    expect(snapshot.rateLimits).toEqual({
      source: "codex",
      remaining: 42,
      resetAt: "2026-03-08T00:30:00.000Z",
    });
  });

  it("falls back to tracker rate-limit data when no live worker payload is available", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-tracker-rate-limits-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
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
                        title: "Issue 1",
                        body: "",
                        url: "https://github.com/acme/platform/issues/1",
                        createdAt: "2026-03-08T00:00:00.000Z",
                        updatedAt: "2026-03-08T00:00:00.000Z",
                        labels: {
                          nodes: [],
                        },
                        assignees: {
                          nodes: [],
                        },
                        repository: {
                          name: repository.name,
                          owner: {
                            login: repository.owner,
                          },
                          url: `file://${repository.cloneUrl}`,
                        },
                        blockedBy: {
                          nodes: [],
                        },
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-used": "2",
              "x-ratelimit-reset": "1773892920",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      ) as never,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4211,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:06:00.000Z"),
    });

    const snapshot = await service.runOnce();

    expect(snapshot.rateLimits).toEqual({
      source: "github",
      limit: 5000,
      remaining: 4998,
      used: 2,
      reset: 1773892920,
      resetAt: "2026-03-19T04:02:00.000Z",
      resource: "graphql",
    });
  });

  it("preserves live worker rate-limit data when tracker calls fail", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-live-rate-limits-on-tracker-failure-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveRun({
      runId: "run-1",
      projectId: projectConfig.projectId,
      projectSlug: projectConfig.slug,
      issueId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueSubjectId: "issue-1",
      issueState: "Todo",
      issueWorkspaceKey: deriveIssueWorkspaceKey(
        {
          projectId: projectConfig.projectId,
          adapter: "github-project",
          issueSubjectId: "issue-1",
        },
        "acme/platform#1"
      ),
      repository,
      workerDir: join(tempRoot, "worker"),
      workingDirectory: join(tempRoot, "workspace"),
      workspaceRuntimeDir: join(tempRoot, "workspace-runtime"),
      workflowPath: null,
      workspaceBranch: "sym/test",
      status: "running",
      attempt: 1,
      processId: 4112,
      port: 4312,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      sessionId: null,
      turnCount: 0,
      tokenUsage: null,
      executionPhase: "implementation",
      runPhase: "streaming_turn",
      rateLimits: {
        source: "codex",
        remaining: 41,
        resetAt: "2026-03-08T00:45:00.000Z",
      },
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      throw new Error("tracker unavailable");
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      isProcessRunning: (pid) => pid === 4112,
      now: () => new Date("2026-03-08T00:06:00.000Z"),
    });

    const snapshot = await service.runOnce();

    expect(snapshot.lastError).toContain("tracker unavailable");
    expect(snapshot.rateLimits).toEqual({
      source: "codex",
      remaining: 41,
      resetAt: "2026-03-08T00:45:00.000Z",
    });
  });

  it("prefers the latest tracker rate-limit payload over earlier sync metadata", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-tracker-rate-limits-latest-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveRun({
      runId: "run-1",
      projectId: projectConfig.projectId,
      projectSlug: projectConfig.slug,
      issueId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueSubjectId: "issue-1",
      issueState: "Todo",
      issueWorkspaceKey: deriveIssueWorkspaceKey(
        {
          projectId: projectConfig.projectId,
          adapter: "github-project",
          issueSubjectId: "issue-1",
        },
        "acme/platform#1"
      ),
      repository,
      workerDir: join(tempRoot, "worker"),
      workingDirectory: join(tempRoot, "workspace"),
      workspaceRuntimeDir: join(tempRoot, "workspace-runtime"),
      workflowPath: null,
      workspaceBranch: "sym/test",
      status: "running",
      attempt: 1,
      processId: 4113,
      port: 4313,
      retryKind: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      sessionId: null,
      turnCount: 0,
      tokenUsage: null,
      executionPhase: "implementation",
      runPhase: "streaming_turn",
      rateLimits: null,
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/state")) {
        return {
          ok: true,
          json: async () => ({
            status: "running",
            executionPhase: "implementation",
            runPhase: "streaming_turn",
            run: {
              lastError: null,
            },
          }),
        } as Response;
      }

      const body = JSON.parse(String(init?.body)) as {
        query: string;
      };
      if (body.query.includes("query IssueStatesByIds")) {
        return new Response(
          JSON.stringify({
            data: {
              nodes: [
                {
                  ...makeTrackerIssueStateLookupNode(repository, "Todo"),
                },
              ],
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-used": "1",
              "x-ratelimit-reset": "1773892800",
              "x-ratelimit-resource": "graphql",
            },
          }
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            node: {
              __typename: "ProjectV2",
              items: {
                nodes: [
                  makeTrackerProjectItem(repository, "Todo"),
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4997",
            "x-ratelimit-used": "3",
            "x-ratelimit-reset": "1773892860",
            "x-ratelimit-resource": "graphql",
          },
        }
      );
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: fetchImpl as typeof fetch,
      isProcessRunning: (pid) => pid === 4113,
      now: () => new Date("2026-03-08T00:06:00.000Z"),
    });

    const snapshot = await service.runOnce();

    expect(snapshot.rateLimits).toEqual({
      source: "github",
      limit: 5000,
      remaining: 4997,
      used: 3,
      reset: 1773892860,
      resetAt: "2026-03-19T04:01:00.000Z",
      resource: "graphql",
    });
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
        completedOnce: false,
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
        completedOnce: false,
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
    const workspaceRuntimeDir = join(tempRoot, "stale-run");
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        completedOnce: false,
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
    await mkdir(workspaceRuntimeDir, { recursive: true });
    await writeFile(
      join(workspaceRuntimeDir, "token-usage.json"),
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

  it("falls back to the legacy nested token usage artifact when needed", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-token-usage-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const workspaceRuntimeDir = join(tempRoot, "stale-run");
    const legacyArtifactDir = join(
      workspaceRuntimeDir,
      ".orchestrator",
      "runs",
      "run-1"
    );
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        completedOnce: false,
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
    await mkdir(legacyArtifactDir, { recursive: true });
    await writeFile(
      join(legacyArtifactDir, "token-usage.json"),
      JSON.stringify(
        {
          inputTokens: 55,
          outputTokens: 10,
          totalTokens: 65,
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
      inputTokens: 55,
      outputTokens: 10,
      totalTokens: 65,
    });
  });

  it("surfaces worker executionPhase from the persisted run record", async () => {
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
        completedOnce: false,
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
      executionPhase: "planning",
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
      runtimeSession: {
        sessionId: "thread-1-turn-abc",
        threadId: "thread-1",
        status: "active",
        startedAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:04:00.000Z",
        exitClassification: null,
      },
    });

    const fetchImpl = vi.fn().mockResolvedValue(createEmptyTrackerResponse());
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
        completedOnce: false,
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

  it("reuses listIssues results to synchronize active run issueState", async () => {
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
        completedOnce: false,
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

    const listIssues = vi.fn().mockResolvedValue([
      {
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Test issue",
        description: null,
        priority: null,
        state: "In Progress",
        branchName: null,
        url: "https://github.com/acme/platform/issues/1",
        labels: [],
        blockedBy: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          itemId: "item-1",
        },
        metadata: {},
      },
    ]);
    const fetchIssueStatesByIds = vi.fn().mockResolvedValue([
      {
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Test issue",
        description: null,
        priority: null,
        state: "In Progress",
        branchName: null,
        url: "https://github.com/acme/platform/issues/1",
        labels: [],
        blockedBy: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:05:00.000Z",
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          itemId: "item-1",
        },
        metadata: {},
      },
    ]);
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds,
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()) as never,
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4204,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
    });

    const snapshot = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");

    expect(fetchIssueStatesByIds).toHaveBeenCalledTimes(1);
    expect(fetchIssueStatesByIds).toHaveBeenCalledWith(
      projectConfig,
      ["issue-1"],
      expect.objectContaining({
        fetchImpl: expect.any(Function),
      })
    );
    expect(fetchIssueStatesByIds.mock.invocationCallOrder[0]).toBeLessThan(
      listIssues.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(snapshot.activeRuns[0]?.issueState).toBe("In Progress");
    expect(updatedRun?.issueState).toBe("In Progress");
  });

  it("reconciles running issues that moved to a terminal state outside the candidate snapshot", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-terminal-reconciliation-")
    );
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
        completedOnce: false,
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
      issueState: "In Progress",
      repository,
      status: "running",
      attempt: 1,
      processId: 4205,
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

    const listIssues = vi.fn().mockResolvedValue([]);
    const fetchIssueStatesByIds = vi.fn().mockResolvedValue([
      {
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Test issue",
        description: null,
        priority: null,
        state: "Done",
        branchName: null,
        url: "https://github.com/acme/platform/issues/1",
        labels: [],
        blockedBy: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:05:00.000Z",
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          itemId: "item-1",
        },
        metadata: {},
      },
    ]);
    const killImpl = vi.fn();
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds,
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()) as never,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
      killImpl,
      isProcessRunning: vi.fn().mockReturnValue(true),
    });

    const snapshot = await service.runOnce();
    const updatedRun = await store.loadRun("run-1");
    const issueRecords = await store.loadProjectIssueOrchestrations("tenant-1");

    expect(fetchIssueStatesByIds).toHaveBeenCalledTimes(1);
    expect(fetchIssueStatesByIds.mock.invocationCallOrder[0]).toBeLessThan(
      listIssues.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(killImpl).toHaveBeenCalledWith(4205, "SIGTERM");
    expect(updatedRun?.status).toBe("suppressed");
    expect(updatedRun?.issueState).toBe("Done");
    expect(issueRecords[0]?.state).toBe("released");
    expect(snapshot.activeRuns).toHaveLength(0);
  });

  it("releases the iterated orchestration record when suppression matches by identifier", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-suppression-release-")
    );
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
        issueId: "issue-record-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        completedOnce: true,
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
      issueId: "issue-record-1",
      issueSubjectId: "issue-record-1",
      issueIdentifier: "acme/platform#1",
      issueState: "In Progress",
      repository,
      status: "running",
      attempt: 1,
      processId: 4206,
      port: 4602,
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

    const listIssues = vi.fn().mockResolvedValue([]);
    const fetchIssueStatesByIds = vi.fn().mockResolvedValue([
      {
        id: "issue-current-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Test issue",
        description: null,
        priority: null,
        state: "Done",
        branchName: null,
        url: "https://github.com/acme/platform/issues/1",
        labels: [],
        blockedBy: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:05:00.000Z",
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          itemId: "item-1",
        },
        metadata: {},
      },
    ]);
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue({
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds,
      buildWorkerEnvironment: vi.fn().mockReturnValue({
        GITHUB_PROJECT_ID: "project-123",
      }),
      reviveIssue: vi.fn(),
    });

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()) as never,
      now: () => new Date("2026-03-08T00:05:00.000Z"),
      killImpl: vi.fn(),
      isProcessRunning: vi.fn().mockReturnValue(true),
    });

    await service.runOnce();

    const issueRecords = await store.loadProjectIssueOrchestrations("tenant-1");
    expect(issueRecords[0]).toMatchObject({
      issueId: "issue-record-1",
      completedOnce: true,
      state: "released",
      currentRunId: null,
    });
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
        completedOnce: false,
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

  it("loads project .env for repository script hooks during workspace creation", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-hook-project-env-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        rawWorkflow: `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
hooks:
  after_create: scripts/setup-env.sh
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
      }
    );
    await mkdir(join(repository.path, "scripts"), { recursive: true });
    await writeFile(
      join(repository.path, "scripts", "setup-env.sh"),
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$STAGING_API_HOST" > "$SYMPHONY_REPOSITORY_PATH/.after_create_host"\nprintf "%s\\n" "$FILE_ONLY" > "$SYMPHONY_REPOSITORY_PATH/.after_create_file_only"\n',
      "utf8"
    );
    execSync(`git -C ${shell(repository.path)} add scripts/setup-env.sh`, {
      stdio: "ignore",
    });
    execSync(`git -C ${shell(repository.path)} commit -m add-hook-script`, {
      stdio: "ignore",
    });

    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await writeFile(
      join(store.projectDir(projectConfig.projectId), ".env"),
      "STAGING_API_HOST=https://staging.example.com\nFILE_ONLY=from-project-env\n",
      "utf8"
    );

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4303,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();

    const workspaceKey = (
      await store.loadProjectIssueOrchestrations(projectConfig.projectId)
    )[0]?.workspaceKey;
    const repositoryPath = join(
      resolveIssueWorkspaceDirectory(
        store.projectDir(projectConfig.projectId),
        workspaceKey ?? ""
      ),
      "repository"
    );

    await expect(readFile(join(repositoryPath, ".after_create_host"), "utf8")).resolves
      .toBe("https://staging.example.com\n");
    await expect(
      readFile(join(repositoryPath, ".after_create_file_only"), "utf8")
    ).resolves.toBe("from-project-env\n");
  });

  it("applies project .env to inline hooks, with process env override and symphony context precedence", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const originalStagingApiHost = process.env.STAGING_API_HOST;
    const originalSymphonyRepositoryPath = process.env.SYMPHONY_REPOSITORY_PATH;
    process.env.STAGING_API_HOST = "https://ci.example.com";
    process.env.SYMPHONY_REPOSITORY_PATH = "/tmp/should-not-win";

    try {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "orchestrator-inline-hook-project-env-")
      );
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform",
        {
          rawWorkflow: `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
hooks:
  before_run: |
    printf "%s\\n" "$STAGING_API_HOST" > .before_run_host
    printf "%s\\n" "$FILE_ONLY" > .before_run_file_only
    printf "%s\\n" "$SYMPHONY_REPOSITORY_PATH" > .before_run_repository_path
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
        }
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(tempRoot, repository);
      await store.saveProjectConfig(projectConfig);
      await writeFile(
        join(store.projectDir(projectConfig.projectId), ".env"),
        "STAGING_API_HOST=https://staging.example.com\nFILE_ONLY=from-project-env\nSYMPHONY_REPOSITORY_PATH=/tmp/from-project-env\n",
        "utf8"
      );

      const spawnImpl = vi.fn().mockReturnValue({
        pid: 4304,
        unref: vi.fn(),
      });
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
        spawnImpl: spawnImpl as never,
        now: () => new Date("2026-03-08T00:00:00.000Z"),
      });

      await service.runOnce();

      const workspaceKey = (
        await store.loadProjectIssueOrchestrations(projectConfig.projectId)
      )[0]?.workspaceKey;
      const repositoryPath = join(
        resolveIssueWorkspaceDirectory(
          store.projectDir(projectConfig.projectId),
          workspaceKey ?? ""
        ),
        "repository"
      );

      await expect(readFile(join(repositoryPath, ".before_run_host"), "utf8")).resolves
        .toBe("https://ci.example.com\n");
      await expect(
        readFile(join(repositoryPath, ".before_run_file_only"), "utf8")
      ).resolves.toBe("from-project-env\n");
      await expect(
        readFile(join(repositoryPath, ".before_run_repository_path"), "utf8")
      ).resolves.toBe(`${repositoryPath}\n`);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (originalStagingApiHost === undefined) {
        delete process.env.STAGING_API_HOST;
      } else {
        process.env.STAGING_API_HOST = originalStagingApiHost;
      }
      if (originalSymphonyRepositoryPath === undefined) {
        delete process.env.SYMPHONY_REPOSITORY_PATH;
      } else {
        process.env.SYMPHONY_REPOSITORY_PATH = originalSymphonyRepositoryPath;
      }
    }
  });

  it("includes project .env in worker spawn env and lets process env override it", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const originalStagingApiHost = process.env.STAGING_API_HOST;
    process.env.STAGING_API_HOST = "https://ci.example.com";

    try {
      const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worker-project-env-"));
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(tempRoot, repository);
      await store.saveProjectConfig(projectConfig);
      await writeFile(
        join(store.projectDir(projectConfig.projectId), ".env"),
        "STAGING_API_HOST=https://staging.example.com\nFILE_ONLY=from-project-env\n",
        "utf8"
      );

      const spawnImpl = vi.fn().mockReturnValue({
        pid: 4305,
        unref: vi.fn(),
      });
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
        spawnImpl: spawnImpl as never,
        now: () => new Date("2026-03-08T00:00:00.000Z"),
      });

      await service.runOnce();

      const spawnEnv = spawnImpl.mock.calls[0]?.[2]?.env;
      expect(spawnEnv?.STAGING_API_HOST).toBe("https://ci.example.com");
      expect(spawnEnv?.FILE_ONLY).toBe("from-project-env");
      expect(spawnEnv?.SYMPHONY_ISSUE_SUBJECT_ID).toBe("issue-1");
      expect(spawnEnv?.SYMPHONY_ISSUE_WORKSPACE_KEY).toBeTruthy();
    } finally {
      if (originalStagingApiHost === undefined) {
        delete process.env.STAGING_API_HOST;
      } else {
        process.env.STAGING_API_HOST = originalStagingApiHost;
      }
    }
  });

  it("does not force TARGET_REPOSITORY_URL to an empty string when the repository URL is missing", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const originalTargetRepositoryUrl = process.env.TARGET_REPOSITORY_URL;
    delete process.env.TARGET_REPOSITORY_URL;

    try {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "orchestrator-worker-missing-repository-url-")
      );
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(tempRoot, repository);
      await store.saveProjectConfig(projectConfig);

      const spawnImpl = vi.fn().mockReturnValue({
        pid: 4307,
        unref: vi.fn(),
      });
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi.fn().mockResolvedValue(
          createTrackerResponseWithItems(repository, [
            {
              id: "issue-1",
              identifier: "acme/platform#1",
              state: "Todo",
              repositoryUrl: null,
            },
          ])
        ),
        spawnImpl: spawnImpl as never,
        now: () => new Date("2026-03-08T00:00:00.000Z"),
      });

      await service.runOnce();

      const spawnEnv = spawnImpl.mock.calls[0]?.[2]?.env;
      expect(Object.hasOwn(spawnEnv ?? {}, "TARGET_REPOSITORY_URL")).toBe(false);
    } finally {
      if (originalTargetRepositoryUrl === undefined) {
        delete process.env.TARGET_REPOSITORY_URL;
      } else {
        process.env.TARGET_REPOSITORY_URL = originalTargetRepositoryUrl;
      }
    }
  });

  it("falls back to inherited env when the project .env file cannot be read", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-unreadable-project-env-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await mkdir(join(store.projectDir(projectConfig.projectId), ".env"), {
      recursive: true,
    });

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4308,
      unref: vi.fn(),
    });
    const stderr = {
      write: vi.fn().mockReturnValue(true),
    };
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: spawnImpl as never,
      stderr,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await expect(service.runOnce()).resolves.toMatchObject({
      summary: {
        dispatched: 1,
      },
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to load project env for ${projectConfig.projectId}`
      )
    );
  });

  it("loads project .env for absolute hook paths", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-absolute-hook-project-env-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        rawWorkflow: `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
hooks:
  before_run: ${join(tempRoot, "before-run-hook.sh")}
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
      }
    );
    await writeFile(
      join(tempRoot, "before-run-hook.sh"),
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$STAGING_API_HOST" > "$SYMPHONY_REPOSITORY_PATH/.before_run_absolute_host"\n',
      "utf8"
    );
    await chmod(join(tempRoot, "before-run-hook.sh"), 0o755);
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);
    await writeFile(
      join(store.projectDir(projectConfig.projectId), ".env"),
      "STAGING_API_HOST=https://staging.example.com\n",
      "utf8"
    );

    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: vi.fn().mockReturnValue({
        pid: 4306,
        unref: vi.fn(),
      }) as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();

    const workspaceKey = (
      await store.loadProjectIssueOrchestrations(projectConfig.projectId)
    )[0]?.workspaceKey;
    const repositoryPath = join(
      resolveIssueWorkspaceDirectory(
        store.projectDir(projectConfig.projectId),
        workspaceKey ?? ""
      ),
      "repository"
    );

    await expect(
      readFile(join(repositoryPath, ".before_run_absolute_host"), "utf8")
    ).resolves.toBe("https://staging.example.com\n");
  });

  it("preserves existing behavior when the project .env file is missing", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-missing-project-env-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        rawWorkflow: `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
hooks:
  before_run: |
    printf "%s\\n" "\${FILE_ONLY:-missing}" > .before_run_missing_project_env
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(tempRoot, repository);
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4307,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await service.runOnce();

    const workspaceKey = (
      await store.loadProjectIssueOrchestrations(projectConfig.projectId)
    )[0]?.workspaceKey;
    const repositoryPath = join(
      resolveIssueWorkspaceDirectory(
        store.projectDir(projectConfig.projectId),
        workspaceKey ?? ""
      ),
      "repository"
    );

    await expect(
      readFile(join(repositoryPath, ".before_run_missing_project_env"), "utf8")
    ).resolves.toBe("missing\n");
    expect(spawnImpl.mock.calls[0]?.[2]?.env?.FILE_ONLY).toBeUndefined();
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
      store.projectDir("tenant-1"),
      workspaceKey
    );

    await store.saveProjectIssueOrchestrations("tenant-1", [
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        completedOnce: false,
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
    maxConcurrentAgents?: number;
    stallTimeoutMs?: number;
    includeAfterRunHook?: boolean;
    codexCommand?: string;
    rawWorkflow?: string;
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
    maxConcurrentAgents?: number;
    stallTimeoutMs?: number;
    includeAfterRunHook?: boolean;
    afterRunCommand?: string;
    codexCommand?: string;
    rawWorkflow?: string;
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
    maxConcurrentAgents?: number;
    stallTimeoutMs?: number;
    includeAfterRunHook?: boolean;
    afterRunCommand?: string;
    codexCommand?: string;
    rawWorkflow?: string;
  } = {}
): Promise<void> {
  const content =
    options.rawWorkflow ??
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
  max_concurrent_agents: ${options.maxConcurrentAgents ?? 10}
  max_retry_backoff_ms: ${options.retryMaxDelayMs ?? 30000}
  retry_base_delay_ms: ${options.retryBaseDelayMs ?? 1000}
codex:
  command: ${options.codexCommand ?? "codex app-server"}
  read_timeout_ms: 5000
  stall_timeout_ms: ${options.stallTimeoutMs ?? 300000}
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`;
  await writeFile(
    join(repositoryRoot, "WORKFLOW.md"),
    content,
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

function createTrackerResponseWithItems(
  repository: {
    owner: string;
    name: string;
    cloneUrl: string;
  },
  items: Array<{
    id: string;
    identifier: string;
    state: string;
    repositoryUrl?: string | null;
  }>
) {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          __typename: "ProjectV2",
          items: {
            nodes: items.map((item) => ({
              id: `tracker-${item.id}`,
              updatedAt: "2026-03-08T00:00:00.000Z",
              fieldValues: {
                nodes: [
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: item.state,
                    field: {
                      name: "Status",
                    },
                  },
                ],
              },
              content: {
                __typename: "Issue",
                id: item.id,
                number: Number(item.identifier.split("#")[1]),
                title: item.identifier,
                body: null,
                url: `https://github.com/${repository.owner}/${repository.name}/issues/${item.identifier.split("#")[1]}`,
                createdAt: "2026-03-08T00:00:00.000Z",
                updatedAt: "2026-03-08T00:00:00.000Z",
                labels: {
                  nodes: [],
                },
                blockedBy: {
                  nodes: [],
                },
                repository: {
                  name: repository.name,
                  owner: {
                    login: repository.owner,
                  },
                  url:
                    "repositoryUrl" in item
                      ? item.repositoryUrl
                      : `file://${repository.cloneUrl}`,
                },
              },
            })),
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
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

function makeTrackerProjectItem(
  repository: { owner: string; name: string; cloneUrl: string },
  state: string
) {
  return {
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
      blockedBy: {
        nodes: [],
      },
      assignees: {
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
  };
}

function makeTrackerIssueStateLookupNode(
  repository: { owner: string; name: string; cloneUrl: string },
  state: string
) {
  return {
    __typename: "Issue",
    id: "issue-1",
    number: 1,
    title: "Test issue",
    url: `https://example.test/${repository.owner}/${repository.name}/issues/1`,
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z",
    repository: {
      name: repository.name,
      url: `file://${repository.cloneUrl}`,
      owner: {
        login: repository.owner,
      },
    },
    projectItems: {
      nodes: [
        {
          id: "item-1",
          updatedAt: "2026-03-08T00:00:00.000Z",
          project: {
            id: "project-123",
          },
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
        },
      ],
      pageInfo: {
        hasNextPage: false,
        endCursor: null,
      },
    },
  };
}

function shell(value: string): string {
  return JSON.stringify(value);
}

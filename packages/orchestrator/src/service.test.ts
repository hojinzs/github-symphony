import { execSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "tenant-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4101,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const first = await service.runOnce();
    const second = await service.runOnce();
    const leases = await store.loadTenantLeases("tenant-1");

    expect(first[0]?.summary.dispatched).toBe(1);
    expect(first[0]?.tracker).toEqual({
      adapter: "github-project",
      bindingId: "project-123",
    });
    expect(second[0]?.summary.dispatched).toBe(0);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.status).toBe("active");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "node packages/worker/dist/index.js"],
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

  it("restarts retrying runs after backoff elapses", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-retry-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "tenant-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });
    await store.saveTenantLeases("tenant-1", [
      {
        leaseKey: "issue-1",
        runId: "run-1",
        issueId: "issue-1",
        issueIdentifier: "acme/platform#1",
        status: "active",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      tenantId: "tenant-1",
      tenantSlug: "tenant-1",
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
    const service = new OrchestratorService(store, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:01:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result[0]?.summary.recovered).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
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
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "tenant-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });

    const service = new OrchestratorService(store, {
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
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "tenant-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });
    await store.saveTenantLeases("tenant-1", [
      {
        leaseKey: "issue-1",
        runId: "run-1",
        issueId: "issue-1",
        issueIdentifier: "acme/platform#1",
        status: "active",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      tenantId: "tenant-1",
      tenantSlug: "tenant-1",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      repository,
      status: "running",
      attempt: 1,
      processId: 999999,
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

    const service = new OrchestratorService(store, {
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
    const workspaceRuntimeDir = join(tempRoot, "workspace-runtime-root");
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir,
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });

    const workspaceKey = deriveIssueWorkspaceKey({
      tenantId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });

    await store.saveTenantLeases("tenant-1", [
      {
        leaseKey: "issue-1",
        runId: "run-1",
        issueId: "issue-1",
        issueIdentifier: "acme/platform#1",
        status: "active",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      tenantId: "tenant-1",
      tenantSlug: "tenant-1",
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

    const service = new OrchestratorService(store, {
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

  it("falls back to tenant WORKFLOW.md when repo has none", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-ws-fallback-"));
    const repository = await createBareRepositoryFixture(
      tempRoot,
      "acme",
      "bare-repo"
    );
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "tenant-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });

    // Write tenant-level WORKFLOW.md
    const tenantDir = store.tenantDir("tenant-1");
    await writeFile(
      join(tenantDir, "WORKFLOW.md"),
      `---
github_project_id: project-123
lifecycle:
  state_field: Status
  active_states:
    - Open
  terminal_states:
    - Closed
  blocker_check_states:
    - Open
runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
scheduler:
  poll_interval_ms: 15000
retry:
  base_delay_ms: 1000
  max_delay_ms: 30000
---
Workspace prompt.
`,
      "utf8"
    );

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4301,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, {
      fetchImpl: vi.fn().mockResolvedValue(
        createTrackerResponseWithState(repository, "Open")
      ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    // The tenant WORKFLOW.md has "Open" as active, so it should dispatch
    expect(result[0]?.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
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
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "tenant-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4302,
      unref: vi.fn(),
    });
    const service = new OrchestratorService(store, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    // Repo WORKFLOW.md defines Todo as active, issue is in "Todo" → dispatched
    expect(result[0]?.summary.dispatched).toBe(1);
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
      }
    );
    execSync(`mkdir -p ${shell(join(repository.path, "hooks"))}`);
    await writeFile(
      join(repository.path, "hooks", "after_run.sh"),
      '#!/usr/bin/env bash\nset -eu\nprintf \'%s\' "$SYMPHONY_WORKSPACE_PATH" > "$SYMPHONY_REPOSITORY_PATH/.after_run_workspace_path"\nprintf \'%s\' "$SYMPHONY_REPOSITORY_PATH" > "$SYMPHONY_REPOSITORY_PATH/.after_run_repository_path"\n',
      "utf8"
    );
    execSync(`git -C ${shell(repository.path)} add hooks/after_run.sh`, {
      stdio: "ignore",
    });
    execSync(
      `git -C ${shell(repository.path)} commit -m add-after-run-env-hook`,
      { stdio: "ignore" }
    );

    const store = new OrchestratorFsStore(tempRoot);
    const workspaceRuntimeDir = join(tempRoot, "workspace-runtime-root");
    await store.saveTenantConfig({
      tenantId: "tenant-1",
      slug: "tenant-1",

      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir,
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js",
      },
    });

    const workspaceKey = deriveIssueWorkspaceKey({
      tenantId: "tenant-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const expectedWorkspacePath = resolveIssueWorkspaceDirectory(
      workspaceRuntimeDir,
      "tenant-1",
      workspaceKey
    );

    await store.saveTenantLeases("tenant-1", [
      {
        leaseKey: "issue-1",
        runId: "run-1",
        issueId: "issue-1",
        issueIdentifier: "acme/platform#1",
        status: "active",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun({
      runId: "run-1",
      tenantId: "tenant-1",
      tenantSlug: "tenant-1",
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

    const service = new OrchestratorService(store, {
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

async function commitWorkflowFixture(
  repositoryRoot: string,
  options: {
    schedulerPollIntervalMs?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    includeAfterRunHook?: boolean;
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
    includeAfterRunHook?: boolean;
  } = {}
): Promise<void> {
  await writeFile(
    join(repositoryRoot, "WORKFLOW.md"),
    `---
github_project_id: project-123
lifecycle:
  state_field: Status
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
${options.includeAfterRunHook ? "  after_run: hooks/after_run.sh" : ""}
scheduler:
  poll_interval_ms: ${options.schedulerPollIntervalMs ?? 30000}
retry:
  base_delay_ms: ${options.retryBaseDelayMs ?? 1000}
  max_delay_ms: ${options.retryMaxDelayMs ?? 30000}
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

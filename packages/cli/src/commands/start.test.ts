import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";
import * as configModule from "../config.js";

const orchestratorMocks = vi.hoisted(() => ({
  acquireProjectLock: vi.fn(),
  releaseProjectLock: vi.fn(),
  run: vi.fn(),
  status: vi.fn(),
  shutdown: vi.fn(),
  requestReconcile: vi.fn(),
  acquireWorkerTurnLease: vi.fn(),
  requestAssignedBranchPublish: vi.fn(),
  requestTrackerState: vi.fn(),
  setWorkerOrchestratorUrl: vi.fn(),
  setWorkerOrchestratorToken: vi.fn(),
}));
const {
  acquireProjectLock,
  releaseProjectLock,
  run,
  status,
  shutdown,
  requestReconcile,
  acquireWorkerTurnLease,
  requestAssignedBranchPublish,
  requestTrackerState,
  setWorkerOrchestratorUrl,
  setWorkerOrchestratorToken,
} = orchestratorMocks;
const resolveDashboardResponse = vi.fn();
const isAuthorizedApiRequest = vi.fn();
const loadProjectState = vi.fn();
const startControlPlaneServer = vi.fn();
const HTTP_API_TOKEN = "test-http-api-token";
const serviceDependencies: Array<Record<string, unknown>> = [];
const serviceProjectConfigs: unknown[] = [];
const ghAuthMocks = vi.hoisted(() => ({
  resolveGitHubAuth: vi.fn(),
  runGhAuthLogin: vi.fn(),
  runGhAuthRefresh: vi.fn(),
}));
const promptMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
}));

vi.mock("@gh-symphony/orchestrator", () => ({
  acquireProjectLock: orchestratorMocks.acquireProjectLock,
  releaseProjectLock: orchestratorMocks.releaseProjectLock,
  createStore: vi.fn(() => ({ kind: "store" })),
  getProcessIdentity: vi.fn((pid: number) => `process-${pid}`),
  getProcessStartIdentity: vi.fn((pid: number) => `start-${pid}`),
  isProcessRunning: vi.fn(() => true),
  resolveProjectLockPath: (runtimeRoot: string, projectId: string) =>
    join(runtimeRoot, "projects", projectId, ".lock"),
  getSupportedTrackerKinds: () => ["github-project", "linear", "file"],
  resolveWorkflowConfigTrackerAdapter: () => undefined,
  resolveOrchestratorLogLevel: (value?: string | null) =>
    value === "verbose" ? "verbose" : "normal",
  OrchestratorService: class {
    constructor(
      _store: unknown,
      projectConfig: unknown,
      dependencies: Record<string, unknown> = {}
    ) {
      serviceProjectConfigs.push(projectConfig);
      serviceDependencies.push(dependencies);
    }
    run = orchestratorMocks.run;
    status = orchestratorMocks.status;
    shutdown = orchestratorMocks.shutdown;
    requestReconcile = orchestratorMocks.requestReconcile;
    acquireWorkerTurnLease = orchestratorMocks.acquireWorkerTurnLease;
    requestAssignedBranchPublish =
      orchestratorMocks.requestAssignedBranchPublish;
    requestTrackerState = orchestratorMocks.requestTrackerState;
    setWorkerOrchestratorUrl = orchestratorMocks.setWorkerOrchestratorUrl;
    setWorkerOrchestratorToken = orchestratorMocks.setWorkerOrchestratorToken;
  },
}));

vi.mock("@gh-symphony/dashboard", () => ({
  DashboardFsReader: class {
    constructor(
      public runtimeRoot: string,
      public projectId: string
    ) {}
    loadProjectState = loadProjectState;
  },
  resolveDashboardResponse,
  isAuthorizedApiRequest,
}));

vi.mock("@gh-symphony/control-plane", () => ({
  startControlPlaneServer,
}));

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    confirm: promptMocks.confirm,
  };
});

vi.mock("../github/gh-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/gh-auth.js")>();
  return {
    ...actual,
    resolveGitHubAuth: ghAuthMocks.resolveGitHubAuth,
    runGhAuthLogin: ghAuthMocks.runGhAuthLogin,
    runGhAuthRefresh: ghAuthMocks.runGhAuthRefresh,
  };
});

const startModule = await import("./start.js");
const ghAuth = await import("../github/gh-auth.js");
const githubClient = await import("../github/client.js");
const originalGithubToken = process.env.GITHUB_GRAPHQL_TOKEN;
const originalLinearApiKey = process.env.LINEAR_API_KEY;
const originalHttpApiToken = process.env.GH_SYMPHONY_HTTP_TOKEN;
const originalInstancesDir = process.env.GH_SYMPHONY_INSTANCES_DIR;

beforeEach(() => {
  acquireProjectLock.mockReset();
  releaseProjectLock.mockReset();
  run.mockReset();
  status.mockReset();
  shutdown.mockReset();
  shutdown.mockResolvedValue(undefined);
  requestReconcile.mockReset();
  acquireWorkerTurnLease.mockReset();
  acquireWorkerTurnLease.mockResolvedValue({
    acquired: true,
    expiresAt: "2026-07-15T00:00:15.000Z",
  });
  requestAssignedBranchPublish.mockReset();
  requestAssignedBranchPublish.mockResolvedValue({
    ok: true,
    outcome: "published",
    branch: "symphony/acme-platform-1",
    head: "abc123",
    unpublishedWorktree: null,
    error: null,
  });
  requestTrackerState.mockReset();
  requestTrackerState.mockResolvedValue({
    ok: true,
    outcome: "confirmed",
    state: "In review",
    expectedState: "In progress",
    targetState: "In review",
    reason: "validation passed",
    rateLimits: { source: "github", cycleCost: 4 },
    error: null,
  });
  setWorkerOrchestratorUrl.mockReset();
  setWorkerOrchestratorToken.mockReset();
  resolveDashboardResponse.mockReset();
  isAuthorizedApiRequest.mockReset();
  isAuthorizedApiRequest.mockImplementation(
    (request: { headers: { authorization?: string } }, apiToken: string) =>
      request.headers.authorization === `Bearer ${apiToken}`
  );
  loadProjectState.mockReset();
  loadProjectState.mockResolvedValue({
    activeRuns: [{ issueIdentifier: "acme/platform#1" }],
  });
  startControlPlaneServer.mockReset();
  resolveDashboardResponse.mockImplementation(
    async ({ pathname, method }: { pathname: string; method?: string }) => ({
      status: 200,
      payload: { pathname, method: method ?? "GET" },
    })
  );
  startControlPlaneServer.mockImplementation(
    async ({ port }: { port: number }) =>
      createMockControlPlaneStartResult(port)
  );
  ghAuthMocks.resolveGitHubAuth.mockReset();
  ghAuthMocks.resolveGitHubAuth.mockResolvedValue({
    source: "gh",
    token: "validated-token",
    login: "octocat",
    scopes: ["repo", "read:org", "project"],
  });
  ghAuthMocks.runGhAuthLogin.mockReset();
  ghAuthMocks.runGhAuthRefresh.mockReset();
  promptMocks.confirm.mockReset();
  promptMocks.confirm.mockResolvedValue(true);
  childProcessMocks.spawn.mockClear();
  childProcessMocks.spawn.mockImplementation((_command, _args, options) =>
    createSpawnedChild(
      2468,
      (options?.env as NodeJS.ProcessEnv | undefined)
        ?.GH_SYMPHONY_DAEMON_READY_PATH
    )
  );
  process.env.GITHUB_GRAPHQL_TOKEN = originalGithubToken;
  process.env.LINEAR_API_KEY = originalLinearApiKey;
  process.env.GH_SYMPHONY_HTTP_TOKEN = HTTP_API_TOKEN;
  process.env.GH_SYMPHONY_INSTANCES_DIR = join(
    tmpdir(),
    `cli-start-instances-${process.pid}-${Date.now()}`
  );
  serviceDependencies.length = 0;
  serviceProjectConfigs.length = 0;
});

function createSpawnedChild(
  pid: number,
  readyPath?: string
): EventEmitter & {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = Object.assign(new EventEmitter(), {
    pid,
    unref: vi.fn(),
    kill: vi.fn(),
  });
  queueMicrotask(async () => {
    if (readyPath) await writeFile(readyPath, `${pid}\n`);
    child.emit("spawn");
  });
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  process.env.GITHUB_GRAPHQL_TOKEN = originalGithubToken;
  process.env.LINEAR_API_KEY = originalLinearApiKey;
  process.env.GH_SYMPHONY_HTTP_TOKEN = originalHttpApiToken;
  process.env.GH_SYMPHONY_INSTANCES_DIR = originalInstancesDir;
});

function forceTty(value: boolean): () => void {
  const originalStdinTty = process.stdin.isTTY;
  const originalStdoutTty = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
  return () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinTty,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutTty,
    });
  };
}

describe("shutdownForegroundOrchestrator", () => {
  it("exits after releasing the foreground lock", async () => {
    const exit = vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? "undefined"}`);
    }) as unknown as (code?: number) => never;

    await expect(
      startModule.shutdownForegroundOrchestrator({
        configDir: "/tmp/gh-symphony",
        projectId: "tenant-a",
        exit,
      })
    ).rejects.toThrow("exit:0");
  });

  it("releases the project lock before exiting", async () => {
    const exit = vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? "undefined"}`);
    }) as unknown as (code?: number) => never;
    const projectLock = {
      lockPath: "/tmp/project/.lock",
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };

    await expect(
      startModule.shutdownForegroundOrchestrator({
        configDir: "/tmp/gh-symphony",
        projectId: "tenant-a",
        projectLock,
        releaseLock: releaseProjectLock,
        exit,
      })
    ).rejects.toThrow("exit:0");

    expect(releaseProjectLock).toHaveBeenCalledWith(projectLock);
  });
});

describe("start command foreground locking", () => {
  it("fails before constructing the daemon for an unsupported tracker kind", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const workflowPath = join(configDir, "invalid-workflow.md");
    const projectPath = join(configDir, "projects", "tenant-a", "project.json");
    const project = JSON.parse(
      await readFile(projectPath, "utf8")
    ) as CliProjectConfig;
    project.workflowSource = { type: "repo", path: workflowPath };
    await writeFile(projectPath, JSON.stringify(project), "utf8");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: retired-kind
codex:
  command: codex app-server
---
Handle {{issue.identifier}}.\n`,
      "utf8"
    );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain("Workflow preflight failed");
    expect(acquireProjectLock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("uses the managed project .env when preflighting a configured workflow", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const projectDir = join(configDir, "projects", "tenant-a");
    const workflowPath = join(projectDir, "custom-workflow.md");
    const projectPath = join(projectDir, "project.json");
    const project = JSON.parse(
      await readFile(projectPath, "utf8")
    ) as CliProjectConfig;
    project.workflowSource = { type: "repo", path: workflowPath };
    await writeFile(projectPath, JSON.stringify(project), "utf8");
    await writeFile(
      projectDir + "/.env",
      "WORKFLOW_CODEX_COMMAND=codex app-server\n",
      "utf8"
    );
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  provider:
    project_id: project-1
codex:
  command: $WORKFLOW_CODEX_COMMAND
---
Handle {{issue.identifier}}.\n`,
      "utf8"
    );
    acquireProjectLock.mockResolvedValue({
      lockPath: join(projectDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-08-28T00:00:00.000Z",
    });

    await startModule.default([], baseOptions(configDir));

    expect(run).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a remediation when the explicitly configured workflow is missing", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const projectPath = join(configDir, "projects", "tenant-a", "project.json");
    const project = JSON.parse(
      await readFile(projectPath, "utf8")
    ) as CliProjectConfig;
    project.workflowSource = {
      type: "repo",
      path: join(configDir, "missing-workflow.md"),
    };
    await writeFile(projectPath, JSON.stringify(project), "utf8");
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain("Configured workflow not found");
    expect(acquireProjectLock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [
      "not_installed",
      "gh CLI is not installed.",
      "Install gh CLI from https://cli.github.com or set GITHUB_GRAPHQL_TOKEN.",
    ],
    [
      "not_authenticated",
      "gh CLI is not authenticated.",
      "Run 'gh auth login --scopes repo,read:org,project', then re-run 'gh-symphony repo start'.",
    ],
    [
      "missing_scopes",
      "Run 'gh auth refresh --scopes repo,read:org,project'. Missing scopes: project",
      "Run 'gh auth refresh --scopes project', then re-run 'gh-symphony repo start'.",
    ],
    [
      "invalid_token",
      "GITHUB_GRAPHQL_TOKEN is invalid or expired.",
      "Run 'gh auth login --scopes repo,read:org,project' to re-authenticate, then re-run 'gh-symphony repo start'.",
    ],
    [
      "token_failed",
      "gh CLI token could not be validated.",
      "Run 'gh auth login --scopes repo,read:org,project' to re-authenticate, then re-run 'gh-symphony repo start'.",
    ],
  ] as const)(
    "fails fast before constructing the orchestrator when GitHub auth returns %s",
    async (code, message, expectedHint) => {
      const configDir = await createConfigFixture({
        activeProject: "tenant-a",
        projects: [createProject("tenant-a", "acme", "platform")],
      });
      ghAuthMocks.resolveGitHubAuth.mockRejectedValue(
        new ghAuth.GhAuthError(code, message, {
          missingScopes: code === "missing_scopes" ? ["project"] : undefined,
          currentScopes:
            code === "missing_scopes" ? ["repo", "read:org"] : undefined,
        })
      );
      const stderr = captureWrites(process.stderr);

      try {
        await startModule.default([], baseOptions(configDir));
      } finally {
        stderr.restore();
      }

      expect(stderr.output()).toContain(expectedHint);
      expect(acquireProjectLock).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(serviceDependencies).toHaveLength(0);
      expect(process.exitCode).toBe(1);
    }
  );

  it("stores the validated GitHub token before starting orchestration", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async () => {
      process.emit("SIGINT");
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    await startModule.default([], baseOptions(configDir));

    expect(process.env.GITHUB_GRAPHQL_TOKEN).toBe("validated-token");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("normalizes legacy project config before constructing the orchestrator", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async () => {
      process.emit("SIGINT");
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    await startModule.default([], baseOptions(configDir));

    expect(serviceProjectConfigs.at(-1)).toMatchObject({
      workflowSource: { type: "repo" },
      populateStrategy: "clone",
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("rejects legacy repo metadata before constructing the orchestrator", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const projectPath = join(configDir, "projects", "tenant-a", "project.json");
    const project = JSON.parse(
      await readFile(projectPath, "utf8")
    ) as CliProjectConfig;
    const repositoryPath = join(configDir, "legacy-repository");
    project.repository.path = repositoryPath;
    project.workspaceDir = repositoryPath;
    project.workflowSource = { type: "repo" };
    delete project.repositoryDir;
    await writeFile(projectPath, JSON.stringify(project), "utf8");

    await expect(
      startModule.default([], baseOptions(configDir))
    ).rejects.toThrow(
      "Stop the daemon and run 'gh-symphony repo init' again before starting it."
    );

    expect(acquireProjectLock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(serviceProjectConfigs).toHaveLength(0);
  });

  it("reports the env token source when GitHub auth resolves from GITHUB_GRAPHQL_TOKEN", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    ghAuthMocks.resolveGitHubAuth.mockResolvedValue({
      source: "env",
      token: "env-token",
      login: "env-user",
      scopes: ["repo", "read:org", "project"],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async () => {
      process.emit("SIGINT");
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain(
      "Authenticated via GITHUB_GRAPHQL_TOKEN as env-user"
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("warns when both auth sources are configured and names the source used", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    ghAuthMocks.resolveGitHubAuth.mockResolvedValue({
      source: "env",
      token: "env-token",
      login: "env-user",
      scopes: ["repo", "read:org", "project"],
      configuredSources: ["env", "gh"],
    });
    acquireProjectLock.mockResolvedValue({
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    run.mockImplementation(async () => {
      process.emit("SIGINT");
    });
    vi.spyOn(process, "exit").mockImplementation(
      ((_code?: number) => undefined) as (code?: number) => never
    );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Both GITHUB_GRAPHQL_TOKEN and gh CLI authentication are configured"
    );
    expect(stderr.output()).toContain(
      "This operation is using GITHUB_GRAPHQL_TOKEN"
    );
  });

  it("does not offer interactive gh remediation for env-token auth failures", async () => {
    const restoreTty = forceTty(true);
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    ghAuthMocks.resolveGitHubAuth.mockRejectedValue(
      new ghAuth.GhAuthError(
        "missing_scopes",
        "GITHUB_GRAPHQL_TOKEN is missing required scopes: project",
        {
          missingScopes: ["project"],
          currentScopes: ["repo", "read:org"],
          source: "env",
        }
      )
    );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
      restoreTty();
    }

    expect(stderr.output()).toContain("Update GITHUB_GRAPHQL_TOKEN");
    expect(stderr.output()).not.toContain("Run 'undefined' now?");
    expect(promptMocks.confirm).not.toHaveBeenCalled();
    expect(ghAuthMocks.runGhAuthRefresh).not.toHaveBeenCalled();
    expect(ghAuthMocks.runGhAuthLogin).not.toHaveBeenCalled();
    expect(acquireProjectLock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("runs interactive gh scope remediation and starts with the refreshed token", async () => {
    const restoreTty = forceTty(true);
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    ghAuthMocks.resolveGitHubAuth
      .mockRejectedValueOnce(
        new ghAuth.GhAuthError(
          "missing_scopes",
          "Run 'gh auth refresh --scopes repo,read:org,project'. Missing scopes: project",
          {
            missingScopes: ["project"],
            currentScopes: ["repo", "read:org"],
            source: "gh",
          }
        )
      )
      .mockResolvedValueOnce({
        source: "gh",
        token: "refreshed-token",
        login: "octocat",
        scopes: ["repo", "read:org", "project"],
      });
    ghAuthMocks.runGhAuthRefresh.mockReturnValue({
      status: "applied",
      summary: "GitHub auth scopes refreshed.",
    });
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async () => {
      process.emit("SIGINT");
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
      restoreTty();
    }

    expect(promptMocks.confirm).toHaveBeenCalledWith({
      message: "Run 'gh auth refresh --scopes project' now?",
      initialValue: true,
    });
    expect(ghAuthMocks.runGhAuthRefresh).toHaveBeenCalledWith({
      interactive: true,
    });
    expect(ghAuthMocks.runGhAuthLogin).not.toHaveBeenCalled();
    expect(stderr.output()).toContain("GitHub auth scopes refreshed.");
    expect(process.env.GITHUB_GRAPHQL_TOKEN).toBe("refreshed-token");
    expect(acquireProjectLock).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("fails fast for Linear projects when LINEAR_API_KEY is missing", async () => {
    const linearProject = createProject("tenant-a", "acme", "platform");
    linearProject.tracker = {
      adapter: "linear",
      bindingId: "linear-workspace",
      settings: {},
    };
    delete process.env.LINEAR_API_KEY;
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [linearProject],
    });
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Set LINEAR_API_KEY in the environment before running 'gh-symphony repo start'."
    );
    expect(ghAuthMocks.resolveGitHubAuth).not.toHaveBeenCalled();
    expect(acquireProjectLock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("runs a single orchestration tick and exits naturally with --once", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async (options?: { once?: boolean }) => {
      expect(options).toEqual({ once: true });
      const onTick = serviceDependencies.at(-1)?.onTick as
        | ((snapshot: Record<string, unknown>) => Promise<void>)
        | undefined;
      await onTick?.({
        projectId: "tenant-a",
        slug: "tenant-a",
        health: "idle",
        lastTickAt: "2026-03-17T00:00:00.000Z",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      });
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    await startModule.default(["--once"], baseOptions(configDir));

    expect(run).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("passes --assigned-only to the orchestrator as runtime input", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async () => {
      process.emit("SIGINT");
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    await startModule.default(["--assigned-only"], baseOptions(configDir));

    expect(serviceDependencies.at(-1)).toMatchObject({
      assignedOnly: true,
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("rejects the conflicting --daemon --once combination", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default(["--daemon", "--once"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Options '--daemon' and '--once' cannot be used together"
    );
    expect(acquireProjectLock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("rejects the conflicting --http --web combination", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default(["--http", "--web"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Options '--http' and '--web' cannot be used together"
    );
    expect(acquireProjectLock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(startControlPlaneServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("acquires and releases the project lock in foreground mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    status.mockResolvedValue(null);
    run.mockImplementation(async () => {
      const onTick = serviceDependencies.at(-1)?.onTick as
        | ((snapshot: Record<string, unknown>) => Promise<void>)
        | undefined;
      await onTick?.({
        projectId: "tenant-a",
        slug: "tenant-a",
        health: "idle",
        lastTickAt: "2026-03-17T00:00:00.000Z",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      });
      process.emit("SIGINT");
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    await startModule.default([], baseOptions(configDir));

    expect(acquireProjectLock).toHaveBeenCalledWith({
      runtimeRoot: configDir,
      projectId: "tenant-a",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(serviceDependencies.at(-1)).toMatchObject({
      ownerToken: "owner",
      ownerProcessIdentity: "start-1234",
    });
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("maps the global verbose option to orchestrator verbose logs", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    acquireProjectLock.mockResolvedValue({
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    run.mockResolvedValue(undefined);

    await startModule.default([], {
      ...baseOptions(configDir),
      verbose: true,
    });

    expect(serviceDependencies.at(-1)).toMatchObject({
      logLevel: "verbose",
    });
  });

  it("passes global verbose through to daemon child diagnostics", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });

    await startModule.default(["--daemon"], {
      ...baseOptions(configDir),
      verbose: true,
    });

    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    const childArgs = childProcessMocks.spawn.mock.calls[0]?.[1];
    expect(childArgs).toEqual(
      expect.arrayContaining([
        "repo",
        "start",
        "--verbose",
        "--log-level",
        "verbose",
      ])
    );
    const pidRecord = JSON.parse(
      await readFile(
        join(configDir, "projects", "tenant-a", "daemon.pid"),
        "utf8"
      )
    ) as { pid: number; processIdentity: string; startedAt: string };
    expect(pidRecord).toMatchObject({
      pid: 2468,
      processIdentity: "process-2468",
      cwd: process.cwd(),
    });
    expect(Date.parse(pidRecord.startedAt)).not.toBeNaN();
  });

  it("starts the active external project daemon from its project directory", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "standalone-project-"));
    const workflowPath = join(projectDir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  provider:
    project_id: project-1
codex:
  command: codex app-server
---
Handle {{issue.identifier}}.\n`,
      "utf8"
    );
    const configDir = await createConfigFixture({
      activeProject: "standalone",
      projects: [
        {
          ...createProject("standalone", "acme", "platform"),
          projectDir,
          workflowSource: {
            type: "external",
            path: workflowPath,
          },
        },
        createProject("other-project", "beta", "api"),
      ],
    });

    const stdout = captureWrites(process.stdout);
    try {
      await startModule.default(["--daemon"], {
        ...baseOptions(configDir),
        invocation: "project",
      });
    } finally {
      stdout.restore();
    }

    expect(childProcessMocks.spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: projectDir,
      env: expect.objectContaining({
        GH_SYMPHONY_CONFIG_DIR: resolve(configDir),
        GH_SYMPHONY_DAEMON_PROJECT_ID: "standalone",
      }),
    });
    const pidRecord = JSON.parse(
      await readFile(
        join(configDir, "projects", "standalone", "daemon.pid"),
        "utf8"
      )
    ) as { cwd: string };
    expect(pidRecord.cwd).toBe(projectDir);
    expect(stdout.output()).toContain("Stop with: gh-symphony project stop");
  });

  it("does not leave a PID file when daemon spawn fails", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-start-spawn-"));
    await configModule.saveGlobalConfig(configDir, {
      activeProject: "tenant-a",
      projects: ["tenant-a"],
    });
    await configModule.saveProjectConfig(
      configDir,
      "tenant-a",
      createProject("tenant-a", "acme", "platform")
    );
    let child:
      | (EventEmitter & {
          pid: undefined;
          unref: ReturnType<typeof vi.fn>;
          kill: ReturnType<typeof vi.fn>;
        })
      | null = null;
    childProcessMocks.spawn.mockImplementation(() => {
      child = Object.assign(new EventEmitter(), {
        pid: undefined,
        unref: vi.fn(),
        kill: vi.fn(),
      });
      queueMicrotask(() => child?.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(
      startModule.default(["--daemon"], baseOptions(configDir))
    ).rejects.toThrow("spawn failed");
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(child?.unref).not.toHaveBeenCalled();
  });

  it("does not write a PID file until the daemon child acquires its lock", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    childProcessMocks.spawn.mockImplementation(() => {
      const child = createSpawnedChild(2468);
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    });

    await expect(
      startModule.default(["--daemon"], baseOptions(configDir))
    ).rejects.toThrow("Daemon exited before acquiring the project lock");
    await expect(
      startModule.default(["--daemon"], baseOptions(configDir))
    ).rejects.toThrow(
      join(configDir, "projects", "tenant-a", "orchestrator.log")
    );
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tails completed worker logs from the flat runtime run path", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    await mkdir(join(configDir, "runs", "run-1"), { recursive: true });
    await writeFile(
      join(configDir, "runs", "run-1", "worker.log"),
      "first line\nlast failure\n",
      "utf8"
    );
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    status.mockResolvedValue(null);
    run.mockImplementation(async () => {
      const onTick = serviceDependencies.at(-1)?.onTick as
        | ((snapshot: Record<string, unknown>) => Promise<void>)
        | undefined;
      await onTick?.({
        repository: { owner: "acme", name: "platform" },
        tracker: { adapter: "github-project", bindingId: "project-1" },
        health: "running",
        lastTickAt: "2026-03-17T00:00:00.000Z",
        summary: {
          dispatched: 1,
          suppressed: 0,
          recovered: 0,
          skipped: 3,
          activeRuns: 1,
        },
        activeRuns: [
          {
            runId: "run-1",
            issueIdentifier: "acme/platform#1",
            issueState: "In Progress",
            status: "running",
          },
        ],
        retryQueue: [],
        lastError: null,
      });
      await onTick?.({
        repository: { owner: "acme", name: "platform" },
        tracker: { adapter: "github-project", bindingId: "project-1" },
        health: "idle",
        lastTickAt: "2026-03-17T00:01:00.000Z",
        summary: {
          dispatched: 1,
          suppressed: 0,
          recovered: 0,
          skipped: 3,
          activeRuns: 0,
        },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      });
      process.emit("SIGINT");
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("Worker stderr (acme/platform#1):");
    expect(stdout.output()).toContain("last failure");
    expect(stdout.output()).toContain("item(s) skipped by the tracker");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not classify snapshot error text as a GitHub auth failure", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async () => {
      const onTick = serviceDependencies.at(-1)?.onTick as
        | ((snapshot: Record<string, unknown>) => Promise<void>)
        | undefined;
      await onTick?.({
        repository: { owner: "acme", name: "platform" },
        tracker: { adapter: "github-project", bindingId: "project-1" },
        health: "degraded",
        lastTickAt: "2026-03-17T00:01:00.000Z",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: "Token is missing required GitHub scopes.",
      });
      process.emit("SIGINT");
      await onTick?.({
        repository: { owner: "acme", name: "platform" },
        tracker: { adapter: "github-project", bindingId: "project-1" },
        health: "degraded",
        lastTickAt: "2026-03-17T00:02:00.000Z",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: "Token is missing required GitHub scopes.",
      });
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).not.toContain(
      "Stopping repo start because GitHub authentication can no longer be validated."
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not classify non-GitHub tracker 401 snapshots as GitHub auth failures", async () => {
    const fileProject = createProject("tenant-a", "acme", "platform");
    fileProject.tracker = {
      adapter: "file",
      bindingId: "file-tracker",
      settings: {
        projectId: "file-tracker",
        repository: "acme/platform",
        issuesPath: "/tmp/issues.json",
      },
    };
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [fileProject],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async () => {
      const onTick = serviceDependencies.at(-1)?.onTick as
        | ((snapshot: Record<string, unknown>) => Promise<void>)
        | undefined;
      await onTick?.({
        repository: { owner: "acme", name: "platform" },
        tracker: { adapter: "file", bindingId: "file-tracker" },
        health: "degraded",
        lastTickAt: "2026-03-17T00:01:00.000Z",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: "Tracker request failed with status 401",
      });
      process.emit("SIGINT");
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default(["--once"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).not.toContain("gh auth");
    expect(stderr.output()).not.toContain(
      "Stopping repo start because GitHub authentication can no longer be validated."
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("shuts down cleanly when service.run throws a GitHub scope error", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockRejectedValue(
      new githubClient.GitHubScopeError(
        "Token is missing required scopes: project",
        ["project"],
        ["repo", "read:org"]
      )
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Run 'gh auth refresh --scopes project', then re-run 'gh-symphony repo start'."
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("keeps env-token remediation when runtime GitHub auth fails after env preflight", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    ghAuthMocks.resolveGitHubAuth.mockResolvedValue({
      source: "env",
      token: "env-token",
      login: "env-user",
      scopes: ["repo", "read:org", "project"],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockRejectedValue(
      new githubClient.GitHubApiError("Bad credentials", 401)
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain("Update or unset GITHUB_GRAPHQL_TOKEN");
    expect(stderr.output()).not.toContain("gh auth login");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not classify an untyped status 401 message as an auth error", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    status.mockResolvedValue(null);
    let attempts = 0;
    run.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary proxy failure with status 401");
      }

      const onTick = serviceDependencies.at(-1)?.onTick as
        | ((snapshot: Record<string, unknown>) => Promise<void>)
        | undefined;
      await onTick?.({
        projectId: "tenant-a",
        slug: "tenant-a",
        health: "idle",
        lastTickAt: "2026-03-17T00:00:00.000Z",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      });
      process.emit("SIGINT");
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default([], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(run).toHaveBeenCalledTimes(2);
    expect(stderr.output()).not.toContain(
      "Stopping repo start because GitHub authentication can no longer be validated."
    );
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("serves status API routes and refresh over HTTP when --http is enabled", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--http"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      const unauthenticated = await fetch(`${url}/api/v1/state`);
      expect(unauthenticated.status).toBe(401);
      await expect(unauthenticated.json()).resolves.toEqual({
        error: "Unauthorized",
      });
      await expect(
        fetch(`${url}/api/v1/state`, {
          headers: { authorization: `Bearer ${HTTP_API_TOKEN}` },
        }).then((response) => response.json())
      ).resolves.toEqual({
        pathname: "/api/v1/state",
        method: "GET",
      });

      const refreshResponse = await fetch(`${url}/api/v1/refresh`, {
        method: "POST",
        body: JSON.stringify({ reason: "manual" }),
        headers: {
          authorization: `Bearer ${HTTP_API_TOKEN}`,
          "content-type": "application/json",
        },
      });
      expect(refreshResponse.status).toBe(202);
      await expect(refreshResponse.json()).resolves.toEqual({ ok: true });
      expect(requestReconcile).toHaveBeenCalledTimes(1);

      const workerApiToken = setWorkerOrchestratorToken.mock.calls[0]?.[0];
      expect(workerApiToken).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));

      const leaseResponse = await fetch(`${url}/api/v1/worker-turn-lease`, {
        method: "POST",
        body: JSON.stringify({ issueId: "issue-1", runId: "run-1", turn: 2 }),
        headers: {
          authorization: `Bearer ${workerApiToken}`,
          "content-type": "application/json",
        },
      });
      expect(leaseResponse.status).toBe(200);
      await expect(leaseResponse.json()).resolves.toEqual({
        acquired: true,
        expiresAt: "2026-07-15T00:00:15.000Z",
      });
      expect(acquireWorkerTurnLease).toHaveBeenCalledWith({
        issueId: "issue-1",
        runId: "run-1",
        turn: 2,
      });
      const transitionResponse = await fetch(`${url}/api/v1/tracker-state`, {
        method: "POST",
        body: JSON.stringify({
          type: "transition-request",
          expected_state: "In progress",
          target_state: "In review",
          reason: "validation passed",
          comment_body: "agent-authored transition body",
        }),
        headers: {
          "content-type": "application/json",
          "x-symphony-run-id": "run-1",
          "x-symphony-orchestrator-token": workerApiToken,
        },
      });
      expect(transitionResponse.status).toBe(200);
      await expect(transitionResponse.json()).resolves.toMatchObject({
        ok: true,
        outcome: "confirmed",
        state: "In review",
      });
      expect(requestTrackerState).toHaveBeenCalledWith({
        runId: "run-1",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "validation passed",
          commentBody: "agent-authored transition body",
        },
      });
      const publishResponse = await fetch(
        `${url}/api/v1/assigned-branch/publish`,
        {
          method: "POST",
          headers: {
            "x-symphony-run-id": "run-1",
            "x-symphony-orchestrator-token": workerApiToken,
          },
        }
      );
      expect(publishResponse.status).toBe(200);
      await expect(publishResponse.json()).resolves.toEqual({
        ok: true,
        outcome: "published",
        branch: "symphony/acme-platform-1",
        head: "abc123",
        unpublishedWorktree: null,
        error: null,
      });
      expect(requestAssignedBranchPublish).toHaveBeenCalledWith({
        runId: "run-1",
      });
      expect(setWorkerOrchestratorUrl).toHaveBeenCalledWith(url);
      expect(setWorkerOrchestratorToken).toHaveBeenCalledWith(workerApiToken);

      const unauthenticatedResponse = await fetch(
        `${url}/api/v1/tracker-state`,
        {
          method: "POST",
          body: JSON.stringify({ type: "state-read" }),
          headers: {
            "content-type": "application/json",
            "x-symphony-run-id": "run-1",
          },
        }
      );
      expect(unauthenticatedResponse.status).toBe(401);
      await expect(unauthenticatedResponse.json()).resolves.toEqual({
        ok: false,
        outcome: "rejected",
        state: null,
        expectedState: null,
        targetState: null,
        reason: null,
        rateLimits: null,
        error: "tracker_state_authentication_failed",
      });
      const workerStateResponse = await fetch(`${url}/api/v1/worker-state`, {
        method: "POST",
        body: JSON.stringify({ issueIdentifier: "acme/platform#1" }),
        headers: {
          authorization: `Bearer ${workerApiToken}`,
          "content-type": "application/json",
        },
      });
      expect(workerStateResponse.status).toBe(200);
      await expect(workerStateResponse.json()).resolves.toEqual({
        active: true,
      });

      await expect(
        fetch(`${url}/healthz`).then((response) => response.json())
      ).resolves.toEqual({
        pathname: "/healthz",
        method: "GET",
      });

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
  });

  it("starts the control plane server when --web is enabled", async () => {
    process.env.GH_SYMPHONY_HTTP_TOKEN = "custom+token&value%#";
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--web"],
        baseOptions(configDir)
      );

      await waitForHttpUrl(stdout.output);
      expect(startControlPlaneServer).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 4680,
        runtimeRoot: join(configDir, "projects", "tenant-a"),
        apiToken: "custom+token&value%#",
        onRefreshRequest: expect.any(Function),
      });

      expect(stdout.output()).toContain("Web dashboard listening on");
      expect(stdout.output()).toContain("#token=custom%2Btoken%26value%25%23");
      expect(stdout.output()).not.toContain("#token=custom+token&value%#");

      const onRefreshRequest = (
        startControlPlaneServer.mock.calls[0]?.[0] as
          | { onRefreshRequest?: () => void }
          | undefined
      )?.onRefreshRequest;
      if (!onRefreshRequest) {
        throw new Error("Expected onRefreshRequest callback");
      }
      onRefreshRequest();
      expect(requestReconcile).toHaveBeenCalledTimes(1);

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(resolveDashboardResponse).not.toHaveBeenCalled();
  });

  it("passes an explicit port and --bind-all to the control plane server", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    const startPromise = startModule.default(
      ["--web", "4900", "--bind-all"],
      baseOptions(configDir)
    );

    await vi.waitFor(() => {
      expect(startControlPlaneServer).toHaveBeenCalledWith({
        host: "0.0.0.0",
        port: 4900,
        runtimeRoot: join(configDir, "projects", "tenant-a"),
        apiToken: HTTP_API_TOKEN,
        onRefreshRequest: expect.any(Function),
      });
    });

    process.emit("SIGINT");
    await startPromise;

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("keeps the HTTP status API available after a one-shot tick until interrupted", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    run.mockImplementation(async (options?: { once?: boolean }) => {
      expect(options).toEqual({ once: true });
      const onTick = serviceDependencies.at(-1)?.onTick as
        | ((snapshot: Record<string, unknown>) => Promise<void>)
        | undefined;
      await onTick?.({
        projectId: "tenant-a",
        slug: "tenant-a",
        health: "idle",
        lastTickAt: "2026-03-17T00:00:00.000Z",
        summary: {
          dispatched: 0,
          suppressed: 0,
          recovered: 0,
          activeRuns: 0,
        },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      });
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--once", "--http"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      await expect(fetchJsonWithRetry(`${url}/api/v1/state`)).resolves.toEqual({
        pathname: "/api/v1/state",
        method: "GET",
      });
      expect(stdout.output()).toContain(
        "One-shot tick completed; HTTP status API remains available until Ctrl+C"
      );

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
  });

  it("logs handler failures to stderr and returns a generic 500 response", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });
    resolveDashboardResponse.mockRejectedValue(new Error("reader exploded"));

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      const startPromise = startModule.default(
        ["--http"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      const response = await fetch(`${url}/api/v1/state`, {
        headers: { authorization: `Bearer ${HTTP_API_TOKEN}` },
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Internal server error",
      });
      expect(stderr.output()).toContain("[start] HTTP request failed:");
      expect(stderr.output()).toContain("reader exploded");

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
      stderr.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("uses --port in preference to server.port", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const probe = createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, "127.0.0.1", () => resolve())
    );
    const address = probe.address();
    if (!address || typeof address === "string") {
      probe.close();
      throw new Error("Expected TCP address");
    }
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve()))
    );
    await configureWorkflow(configDir, address.port);
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--port", String(address.port)],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      expect(new URL(url).port).toBe(String(address.port));

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("uses server.port when no CLI HTTP option is supplied", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const probe = createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, "127.0.0.1", () => resolve())
    );
    const address = probe.address();
    if (!address || typeof address === "string") {
      probe.close();
      throw new Error("Expected TCP address");
    }
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve()))
    );
    await configureWorkflow(configDir, address.port);
    acquireProjectLock.mockResolvedValue({
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default([], baseOptions(configDir));
      const url = await waitForHttpUrl(stdout.output);
      expect(new URL(url).port).toBe(String(address.port));

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it.each(["--http", "--port"])(
    "uses server.port in preference to a bare %s option",
    async (option) => {
      const configDir = await createConfigFixture({
        activeProject: "tenant-a",
        projects: [createProject("tenant-a", "acme", "platform")],
      });
      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "127.0.0.1", () => resolve())
      );
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        throw new Error("Expected TCP address");
      }
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve()))
      );
      await configureWorkflow(configDir, address.port);
      acquireProjectLock.mockResolvedValue({
        lockPath: join(configDir, ".lock"),
        ownerToken: "owner",
        pid: 1234,
        startedAt: "2026-03-17T00:00:00.000Z",
      });
      let resolveRun: (() => void) | undefined;
      run.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveRun = resolve;
          })
      );
      shutdown.mockImplementation(async () => {
        resolveRun?.();
      });
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(
          ((_code?: number) => undefined) as (code?: number) => never
        );
      const stdout = captureWrites(process.stdout);

      try {
        const startPromise = startModule.default(
          [option],
          baseOptions(configDir)
        );
        const url = await waitForHttpUrl(stdout.output);
        expect(new URL(url).port).toBe(String(address.port));
        process.emit("SIGINT");
        await startPromise;
      } finally {
        stdout.restore();
      }

      expect(exitSpy).toHaveBeenCalledWith(0);
    }
  );

  it("auto-increments an occupied configured port for a bare HTTP alias", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve())
    );
    const address = blocker.address();
    if (!address || typeof address === "string") {
      blocker.close();
      throw new Error("Expected TCP address");
    }
    await configureWorkflow(configDir, address.port);
    acquireProjectLock.mockResolvedValue({
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--http"],
        baseOptions(configDir)
      );
      const url = await waitForHttpUrl(stdout.output);
      expect(Number(new URL(url).port)).toBeGreaterThan(address.port);
      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve()))
      );
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("reads server.port from a legacy repository workflow fallback", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const probe = createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, "127.0.0.1", () => resolve())
    );
    const address = probe.address();
    if (!address || typeof address === "string") {
      probe.close();
      throw new Error("Expected TCP address");
    }
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve()))
    );
    await configureLegacyWorkflow(configDir, address.port);
    acquireProjectLock.mockResolvedValue({
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default([], baseOptions(configDir));
      const url = await waitForHttpUrl(stdout.output);
      expect(new URL(url).port).toBe(String(address.port));

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("continues when an implicit legacy workflow is invalid", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    await configureInvalidLegacyWorkflow(configDir);
    acquireProjectLock.mockResolvedValue({
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );

    await startModule.default(["--once"], baseOptions(configDir));

    expect(run).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("fails when a requested port is already in use", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve())
    );
    const address = blocker.address();
    if (!address || typeof address === "string") {
      blocker.close();
      throw new Error("Expected TCP address");
    }
    acquireProjectLock.mockResolvedValue({
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    try {
      await expect(
        startModule.default(
          ["--port", String(address.port)],
          baseOptions(configDir)
        )
      ).rejects.toThrow(`HTTP server port ${address.port} is already in use`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("propagates lock acquisition failures", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    acquireProjectLock.mockRejectedValue(new Error("lock busy"));

    await expect(
      startModule.default([], baseOptions(configDir))
    ).rejects.toThrow("lock busy");
  });

  it("keeps the HTTP API available through a graceful shutdown", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, ".lock"),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    let resolveRun: (() => void) | undefined;
    run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    shutdown.mockImplementation(async () => {
      resolveRun?.();
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as (code?: number) => never
      );
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--http"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);

      process.emit("SIGINT");
      await startPromise;
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

function captureWrites(stream: NodeJS.WriteStream): {
  output: () => string;
  restore: () => void;
} {
  let buffer = "";
  const spy = vi.spyOn(stream, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write);

  return {
    output: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

async function waitForHttpUrl(
  output: () => string,
  timeoutMs = 5_000
): Promise<string> {
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = output()
      .replace(ansiPattern, "")
      .match(
        /(?:HTTP status API|Web dashboard) listening on .*?(http:\/\/[^\s]+)/
      );
    if (match?.[1]) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for HTTP server log. Output: ${output()}`);
}

async function createMockControlPlaneStartResult(_port: number): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
}> {
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }

  return {
    server,
    port: address.port,
    url: `http://localhost:${address.port}`,
  };
}

async function fetchJsonWithRetry(
  url: string,
  timeoutMs = 5_000
): Promise<unknown> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${HTTP_API_TOKEN}` },
      });
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  throw lastError ?? new Error(`Timed out fetching ${url}`);
}

function baseOptions(configDir: string) {
  return {
    configDir,
    verbose: false,
    json: false,
    noColor: false,
  };
}

function createProject(
  projectId: string,
  owner: string,
  name: string
): CliProjectConfig {
  return {
    projectId,
    slug: projectId,
    workspaceDir: join("/tmp", projectId),
    repository: {
      owner,
      name,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
    },
    tracker: {
      adapter: "github-project",
      bindingId: `${projectId}-project`,
      settings: {
        projectId: `${projectId}-project`,
        token: `${projectId}-token`,
      },
    },
  };
}

async function createConfigFixture(input: {
  activeProject: string;
  projects: CliProjectConfig[];
}): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "cli-start-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        activeProject: input.activeProject,
        token: `${input.activeProject}-token`,
        projects: input.projects.map((project) => project.projectId),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const project of input.projects) {
    const projectDir = join(configDir, "projects", project.projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.json"),
      JSON.stringify(project, null, 2) + "\n",
      "utf8"
    );
  }

  return configDir;
}

async function configureWorkflow(
  configDir: string,
  port: number
): Promise<void> {
  const projectPath = join(configDir, "projects", "tenant-a", "project.json");
  const project = JSON.parse(
    await readFile(projectPath, "utf8")
  ) as CliProjectConfig;
  const workflowPath = join(configDir, "projects", "tenant-a", "WORKFLOW.md");
  project.workflowSource = { type: "repo", path: workflowPath };
  await writeFile(projectPath, JSON.stringify(project), "utf8");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: github-project
server:
  port: ${port}
codex:
  command: codex app-server
---
Prompt\n`,
    "utf8"
  );
}

async function configureLegacyWorkflow(
  configDir: string,
  port: number
): Promise<void> {
  const projectPath = join(configDir, "projects", "tenant-a", "project.json");
  const project = JSON.parse(
    await readFile(projectPath, "utf8")
  ) as CliProjectConfig;
  const repositoryDir = join(configDir, "legacy-repository");
  project.repository.cloneUrl = pathToFileURL(repositoryDir).href;
  project.workflowSource = { type: "repo" };
  await mkdir(repositoryDir, { recursive: true });
  await writeFile(projectPath, JSON.stringify(project), "utf8");
  await writeFile(
    join(repositoryDir, "WORKFLOW.md"),
    `---
tracker:
  kind: github-project
server:
  port: ${port}
codex:
  command: codex app-server
---
Prompt\n`,
    "utf8"
  );
}

async function configureInvalidLegacyWorkflow(
  configDir: string
): Promise<void> {
  const projectPath = join(configDir, "projects", "tenant-a", "project.json");
  const project = JSON.parse(
    await readFile(projectPath, "utf8")
  ) as CliProjectConfig;
  const repositoryDir = join(configDir, "invalid-legacy-repository");
  project.repository.cloneUrl = pathToFileURL(repositoryDir).href;
  project.workflowSource = { type: "repo" };
  await mkdir(repositoryDir, { recursive: true });
  await writeFile(projectPath, JSON.stringify(project), "utf8");
  await writeFile(
    join(repositoryDir, "WORKFLOW.md"),
    "---\nserver:\n  port: invalid\n---\nPrompt\n",
    "utf8"
  );
}

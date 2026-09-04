import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";

const orchestratorRunCli = vi.fn();
const spawnMock = vi.fn();
const selectMock = vi.fn();
const cancelMock = vi.fn();
const getProcessIdentityMock = vi.fn();
const getProcessCwdMock = vi.fn();
const originalCwd = process.cwd();
const originalInstancesDir = process.env.GH_SYMPHONY_INSTANCES_DIR;
const ghAuthMocks = vi.hoisted(() => ({
  resolveGitHubAuth: vi.fn(),
}));

vi.mock("@gh-symphony/orchestrator", () => ({
  runCli: orchestratorRunCli,
  getProcessCwd: getProcessCwdMock,
  getProcessIdentity: getProcessIdentityMock,
  resolveProjectLockPath: (runtimeRoot: string, projectId: string) =>
    join(runtimeRoot, "projects", projectId, ".lock"),
  resolveOrchestratorLogLevel: (value?: string | null) =>
    value === "verbose" ? "verbose" : "normal",
}));

vi.mock("@clack/prompts", async () => {
  const actual =
    await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts");
  return {
    ...actual,
    select: selectMock,
    cancel: cancelMock,
    isCancel: (value: unknown) => value === Symbol.for("clack-cancel"),
  };
});

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../github/gh-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/gh-auth.js")>();
  return {
    ...actual,
    resolveGitHubAuth: ghAuthMocks.resolveGitHubAuth,
  };
});

const runModule = await import("./run.js");
const startModule = await import("./start.js");
const recoverModule = await import("./recover.js");
const stopModule = await import("./stop.js");

beforeEach(() => {
  getProcessIdentityMock.mockReset();
  getProcessIdentityMock.mockImplementation(
    (pid: number) => `node gh-symphony index.js repo start --pid ${pid}`
  );
  getProcessCwdMock.mockReturnValue(process.cwd());
  ghAuthMocks.resolveGitHubAuth.mockReset();
  process.env.GH_SYMPHONY_INSTANCES_DIR = join(
    tmpdir(),
    `cli-lifecycle-instances-${process.pid}-${Date.now()}`
  );
  ghAuthMocks.resolveGitHubAuth.mockResolvedValue({
    source: "gh",
    token: "validated-token",
    login: "octocat",
    scopes: ["repo", "read:org", "project"],
  });
});

afterEach(() => {
  orchestratorRunCli.mockReset();
  spawnMock.mockReset();
  getProcessIdentityMock.mockReset();
  getProcessCwdMock.mockReset();
  selectMock.mockReset();
  cancelMock.mockReset();
  ghAuthMocks.resolveGitHubAuth.mockReset();
  process.env.GH_SYMPHONY_INSTANCES_DIR = originalInstancesDir;
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
});

function setTty(input: boolean, output: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: input,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: output,
    configurable: true,
  });
}

describe("lifecycle command integration", () => {
  it("reads the selected project config directly from the project directory", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });

    await runModule.default(
      ["--project", "tenant-b", "beta/api#42"],
      baseOptions(configDir)
    );

    expect(orchestratorRunCli).toHaveBeenCalledWith([
      "run-issue",
      "--runtime-root",
      configDir,
      "--project-id",
      "tenant-b",
      "--issue",
      "beta/api#42",
    ]);

    const synced = JSON.parse(
      await readFile(
        join(configDir, "projects", "tenant-b", "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;
    expect(synced.projectId).toBe("tenant-b");
    expect(synced.repository).toMatchObject({
      owner: "beta",
      name: "api",
    });
    expect(synced).not.toHaveProperty("repositories");
  });

  it("forwards --log-level to orchestrator single-issue dispatch", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });

    await runModule.default(
      ["--project", "tenant-a", "--log-level", "verbose", "acme/platform#42"],
      baseOptions(configDir)
    );

    expect(orchestratorRunCli).toHaveBeenCalledWith([
      "run-issue",
      "--runtime-root",
      configDir,
      "--project-id",
      "tenant-a",
      "--issue",
      "acme/platform#42",
      "--log-level",
      "verbose",
    ]);
  });

  it("rejects missing --log-level values for single-issue dispatch", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await runModule.default(
      ["--project", "tenant-a", "--log-level", "--watch", "acme/platform#42"],
      baseOptions(configDir)
    );

    expect(orchestratorRunCli).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Option '--log-level' argument missing"
    );
    expect(process.exitCode).toBe(2);
  });

  it("prints JSON when repo run cannot find a runtime config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "run-missing-config-"));
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await runModule.default(["acme/platform#42"], {
      ...baseOptions(configDir),
      json: true,
    });

    expect(orchestratorRunCli).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      error: {
        code: "missing_repository_runtime_config",
        message:
          "No repository runtime config found. Run 'gh-symphony repo init' first.",
      },
    });
  });

  it("auto-selects the only configured project when start omits --project-id", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });

    spawnMock.mockImplementation((_command, _args, options) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 4321,
        stdout: { pipe: vi.fn() },
        stderr: { pipe: vi.fn() },
        unref: vi.fn(),
        kill: vi.fn(),
      });
      const readyPath = (options as { env?: Record<string, string> }).env?.[
        "GH_SYMPHONY_DAEMON_READY_PATH"
      ];
      queueMicrotask(() => {
        if (readyPath) void writeFile(readyPath, `${child.pid}\n`);
        child.emit("spawn");
      });
      return child;
    });

    await startModule.default(["--daemon"], baseOptions(configDir));

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], "project", "start"],
      expect.any(Object)
    );
  });

  it("uses the active project when run omits --project-id in multi-project mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    setTty(false, false);

    await runModule.default(["acme/platform#42"], baseOptions(configDir));

    expect(selectMock).not.toHaveBeenCalled();
    expect(orchestratorRunCli).toHaveBeenCalledWith([
      "run-issue",
      "--runtime-root",
      configDir,
      "--project-id",
      "tenant-a",
      "--issue",
      "acme/platform#42",
    ]);
  });

  it("preserves the cancel exit code when no active project selection is aborted", async () => {
    const configDir = await createConfigFixture({
      activeProject: null,
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    selectMock.mockResolvedValue(Symbol.for("clack-cancel"));
    setTty(true, true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await runModule.default(["acme/platform#7"], baseOptions(configDir));

    expect(orchestratorRunCli).not.toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalledWith("Cancelled.");
    expect(
      stderr.mock.calls.map((call) => String(call[0])).join("")
    ).not.toContain(
      "No repository runtime config found. Run 'gh-symphony repo init' first."
    );
    expect(process.exitCode).toBe(130);
  });

  it("uses the active project in non-interactive multi-project mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    setTty(false, false);
    await runModule.default(["acme/platform#7"], baseOptions(configDir));

    expect(orchestratorRunCli).toHaveBeenCalledWith([
      "run-issue",
      "--runtime-root",
      configDir,
      "--project-id",
      "tenant-a",
      "--issue",
      "acme/platform#7",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects removed project selection flags in daemon mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });

    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await startModule.default(
      ["--project", "tenant-b", "--daemon"],
      baseOptions(configDir)
    );

    expect(spawnMock).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "--project-id has been removed"
    );
    expect(process.exitCode).toBe(2);
  });

  it("stops the active repository daemon files", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });
    await writeFile(
      join(configDir, "projects", "tenant-a", "daemon.pid"),
      JSON.stringify({
        pid: 111,
        startedAt: "2026-07-15T00:00:00.000Z",
        processIdentity: "node gh-symphony index.js repo start --pid 111",
      }) + "\n"
    );
    await writeFile(join(configDir, "projects", "tenant-a", "port"), "41001\n");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | 0
    ) => {
      if (signal === 0) {
        return true;
      }
      if (pid !== 111 || signal !== "SIGTERM") {
        throw new Error(`unexpected kill ${pid} ${String(signal)}`);
      }
      return true;
    }) as typeof process.kill);

    await stopModule.default([], baseOptions(configDir));

    expect(killSpy).toHaveBeenCalledWith(111, 0);
    expect(killSpy).toHaveBeenCalledWith(111, "SIGTERM");
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the configured repository CWD for a legacy daemon PID", async () => {
    const repositoryCwd = await mkdtemp(
      join(tmpdir(), "cli-stop-repository-cwd-")
    );
    const callerCwd = await mkdtemp(join(tmpdir(), "cli-stop-caller-cwd-"));
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform", repositoryCwd)],
    });
    await writeFile(
      join(configDir, "projects", "tenant-a", "daemon.pid"),
      JSON.stringify({
        pid: 111,
        startedAt: "2026-07-15T00:00:00.000Z",
        processIdentity: "node gh-symphony index.js repo start --pid 111",
      }) + "\n"
    );
    getProcessCwdMock.mockReturnValue(repositoryCwd);
    process.chdir(callerCwd);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: NodeJS.Signals | 0) => {
        if (signal === 0) {
          return true;
        }
        if (pid !== 111 || signal !== "SIGTERM") {
          throw new Error(`unexpected kill ${pid} ${String(signal)}`);
        }
        return true;
      });

    await stopModule.default([], baseOptions(configDir));

    expect(killSpy).toHaveBeenCalledWith(111, 0);
    expect(killSpy).toHaveBeenCalledWith(111, "SIGTERM");
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to signal a reused PID with a different process identity", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });
    await writeFile(
      join(configDir, "projects", "tenant-a", "daemon.pid"),
      JSON.stringify({
        pid: 111,
        startedAt: "2026-07-15T00:00:00.000Z",
        processIdentity: "node gh-symphony index.js repo start --owner old",
      }) + "\n"
    );
    getProcessIdentityMock.mockReturnValue(
      "node unrelated-service.js --owner new"
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await stopModule.default([], baseOptions(configDir));

    expect(killSpy).toHaveBeenCalledWith(111, 0);
    expect(killSpy).not.toHaveBeenCalledWith(111, "SIGTERM");
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "no live orchestrator with repository CWD"
    );
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.exitCode).toBe(1);
  });

  it("stops a legacy repo daemon when its recorded identity no longer matches", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });
    await writeFile(
      join(configDir, "projects", "tenant-a", "daemon.pid"),
      JSON.stringify({
        pid: 111,
        startedAt: "2026-07-15T00:00:00.000Z",
        processIdentity: "stale-recorded-identity",
        cwd: process.cwd(),
      }) + "\n"
    );
    getProcessIdentityMock.mockReturnValue(
      "node /opt/gh-symphony/dist/index.js repo start --assigned-only"
    );
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);

    await stopModule.default([], baseOptions(configDir));

    expect(killSpy).toHaveBeenCalledWith(111, "SIGTERM");
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a repository daemon from the project lock when daemon.pid is stale", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });
    await writeFile(
      join(configDir, "projects", "tenant-a", "daemon.pid"),
      JSON.stringify({
        pid: 111,
        startedAt: "2026-07-15T00:00:00.000Z",
        processIdentity: "stale-daemon",
        cwd: process.cwd(),
      }) + "\n"
    );
    await writeFile(
      join(configDir, "projects", "tenant-a", ".lock"),
      JSON.stringify({
        ownerToken: "222:owner",
        pid: 222,
        startedAt: "2026-07-15T00:00:01.000Z",
        heartbeatAt: "2026-07-15T00:00:02.000Z",
        processIdentity: "live-daemon",
      }) + "\n"
    );
    getProcessIdentityMock.mockImplementation((pid: number) =>
      pid === 222 ? "live-daemon" : "unrelated-process"
    );
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | 0) =>
          true) as typeof process.kill
      );

    await stopModule.default([], baseOptions(configDir));

    expect(killSpy).not.toHaveBeenCalledWith(111, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(222, 0);
    expect(killSpy).toHaveBeenCalledWith(222, "SIGTERM");
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not signal an identity-unverified daemon recovered from a lock", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });
    await writeFile(
      join(configDir, "projects", "tenant-a", ".lock"),
      JSON.stringify({
        ownerToken: "222:owner",
        pid: 222,
        startedAt: "2026-07-15T00:00:01.000Z",
        heartbeatAt: new Date().toISOString(),
        processIdentity: null,
        cwd: process.cwd(),
      }) + "\n"
    );
    getProcessIdentityMock.mockReturnValue(null);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | 0) =>
          true) as typeof process.kill
      );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await stopModule.default([], baseOptions(configDir));

    expect(killSpy).toHaveBeenCalledWith(222, 0);
    expect(killSpy).not.toHaveBeenCalledWith(222, "SIGTERM");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("process identity could not be verified")
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects unknown project stop flags before touching daemon state", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    await writeFile(
      join(configDir, "projects", "tenant-a", "daemon.pid"),
      "111\n"
    );

    const killSpy = vi.spyOn(process, "kill");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await stopModule.default(
      ["--proejct-id", "tenant-a"],
      baseOptions(configDir)
    );

    const output = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Unknown option '--proejct-id'");
    expect(output).toContain("Usage: gh-symphony repo stop [--force]");
    expect(killSpy).not.toHaveBeenCalled();
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).resolves.toContain("111");
    expect(process.exitCode).toBe(2);
  });

  it("reports recoverable runs without invoking recovery in dry-run mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });
    const runDir = join(configDir, "projects", "tenant-a", "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify(
        {
          runId: "run-1",
          projectId: "tenant-a",
          issueIdentifier: "acme/platform#7",
          status: "running",
          processId: 999_999,
          startedAt: new Date().toISOString(),
          nextRetryAt: null,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const isProcessRunning = vi.fn().mockReturnValue(false);

    await recoverModule.default(["--dry-run"], baseOptions(configDir), {
      isProcessRunning,
    });

    expect(orchestratorRunCli).not.toHaveBeenCalled();
    expect(isProcessRunning).toHaveBeenCalledWith(999_999);
    expect(
      stdout.mock.calls.some((call) =>
        String(call[0]).includes("acme/platform#7")
      )
    ).toBe(true);
  });
});

function baseOptions(configDir: string) {
  return {
    configDir,
    verbose: false,
    json: false,
    noColor: false,
  };
}

function createTenant(
  projectId: string,
  owner: string,
  name: string,
  workspaceDir = process.cwd()
): CliProjectConfig {
  return {
    projectId,
    slug: projectId,
    workspaceDir,
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
  activeProject: string | null;
  projects: CliProjectConfig[];
}): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "cli-lifecycle-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        activeProject: input.activeProject,
        token: input.activeProject ? `${input.activeProject}-token` : undefined,
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

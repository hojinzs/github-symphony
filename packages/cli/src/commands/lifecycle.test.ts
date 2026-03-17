import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";

const orchestratorRunCli = vi.fn();
const spawnMock = vi.fn();
const selectMock = vi.fn();
const cancelMock = vi.fn();

vi.mock("@gh-symphony/orchestrator", () => ({
  runCli: orchestratorRunCli,
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

const runModule = await import("./run.js");
const startModule = await import("./start.js");
const projectModule = await import("./project.js");
const recoverModule = await import("./recover.js");
const stopModule = await import("./stop.js");

afterEach(() => {
  orchestratorRunCli.mockReset();
  spawnMock.mockReset();
  selectMock.mockReset();
  cancelMock.mockReset();
  vi.restoreAllMocks();
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
  it("syncs the selected project config before single-issue dispatch", async () => {
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
        join(configDir, "orchestrator", "projects", "tenant-b", "config.json"),
        "utf8"
      )
    ) as CliProjectConfig;
    expect(synced.projectId).toBe("tenant-b");
    expect(synced.repositories[0]).toMatchObject({
      owner: "beta",
      name: "api",
    });
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

  it("auto-selects the only configured project when start omits --project-id", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createTenant("tenant-a", "acme", "platform")],
    });

    spawnMock.mockReturnValue({
      pid: 4321,
      stdout: { pipe: vi.fn() },
      stderr: { pipe: vi.fn() },
      unref: vi.fn(),
    });

    await startModule.default(["--daemon"], baseOptions(configDir));

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], "start", "--project", "tenant-a"],
      expect.any(Object)
    );
  });

  it("prompts for project selection when run omits --project-id in interactive multi-project mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    selectMock.mockResolvedValue("tenant-b");
    setTty(true, true);

    await runModule.default(["beta/api#42"], baseOptions(configDir));

    expect(selectMock).toHaveBeenCalled();
    expect(orchestratorRunCli).toHaveBeenCalledWith([
      "run-issue",
      "--runtime-root",
      configDir,
      "--project-id",
      "tenant-b",
      "--issue",
      "beta/api#42",
    ]);
  });

  it("preserves the cancel exit code when interactive project selection is aborted", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
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
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).not.toContain(
      "No project configured. Run 'gh-symphony project add' first."
    );
    expect(process.exitCode).toBe(130);
  });

  it("requires explicit --project-id in non-interactive multi-project mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    setTty(false, false);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await runModule.default(["acme/platform#7"], baseOptions(configDir));

    expect(orchestratorRunCli).not.toHaveBeenCalled();
    const output = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain(
      "Multiple projects are configured. Re-run with --project-id in non-interactive environments."
    );
    expect(process.exitCode).toBe(1);
  });

  it("starts the requested project in daemon mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });

    spawnMock.mockReturnValue({
      pid: 4321,
      stdout: { pipe: vi.fn() },
      stderr: { pipe: vi.fn() },
      unref: vi.fn(),
    });

    await startModule.default(
      ["--project", "tenant-b", "--daemon"],
      baseOptions(configDir)
    );

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], "start", "--project", "tenant-b"],
      expect.objectContaining({
        env: expect.objectContaining({
          GH_SYMPHONY_CONFIG_DIR: configDir,
        }),
      })
    );

    expect(
      await readFile(
        join(configDir, "projects", "tenant-b", "daemon.pid"),
        "utf8"
      )
    ).toBe("4321");
  });

  it("supports project start subcommand for explicit project orchestration", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });

    spawnMock.mockReturnValue({
      pid: 8765,
      stdout: { pipe: vi.fn() },
      stderr: { pipe: vi.fn() },
      unref: vi.fn(),
    });

    await projectModule.default(
      ["start", "--project-id", "tenant-b", "--daemon"],
      baseOptions(configDir)
    );

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], "start", "--project", "tenant-b"],
      expect.any(Object)
    );
  });

  it("routes project status to the requested project's orchestrator snapshot", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    await writeStatusSnapshot(configDir, "tenant-b", {
      slug: "tenant-b",
      health: "running",
    });

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await projectModule.default(
      ["status", "--project-id", "tenant-b"],
      baseOptions(configDir)
    );

    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("gh-symphony");
    expect(output).toContain("tenant-b");
    expect(output).not.toContain("tenant-a");
  });

  it("rejects unknown project status flags instead of falling back to the active project", async () => {
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

    await projectModule.default(
      ["status", "--proejct-id", "tenant-b"],
      baseOptions(configDir)
    );

    const output = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Unknown option '--proejct-id'");
    expect(output).toContain(
      "Usage: gh-symphony status [--project-id <project-id>] [--watch]"
    );
    expect(process.exitCode).toBe(2);
  });

  it("stops only the requested project's daemon files", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    await writeFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "111\n");
    await writeFile(join(configDir, "projects", "tenant-a", "port"), "41001\n");
    await writeFile(join(configDir, "projects", "tenant-b", "daemon.pid"), "222\n");
    await writeFile(join(configDir, "projects", "tenant-b", "port"), "41002\n");

    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (signal === 0) {
          return true;
        }
        if (pid !== 111 || signal !== "SIGTERM") {
          throw new Error(`unexpected kill ${pid} ${String(signal)}`);
        }
        return true;
      }) as typeof process.kill);

    await stopModule.default(["--project-id", "tenant-a"], baseOptions(configDir));

    expect(killSpy).toHaveBeenCalledWith(111, 0);
    expect(killSpy).toHaveBeenCalledWith(111, "SIGTERM");
    await expect(
      readFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(configDir, "projects", "tenant-b", "daemon.pid"), "utf8")
    ).resolves.toContain("222");
    await expect(
      readFile(join(configDir, "projects", "tenant-b", "port"), "utf8")
    ).resolves.toContain("41002");
  });

  it("rejects unknown project stop flags before touching daemon state", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });
    await writeFile(join(configDir, "projects", "tenant-a", "daemon.pid"), "111\n");

    const killSpy = vi.spyOn(process, "kill");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await stopModule.default(["--proejct-id", "tenant-a"], baseOptions(configDir));

    const output = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Unknown option '--proejct-id'");
    expect(output).toContain(
      "Usage: gh-symphony stop --project-id <project-id> [--force]"
    );
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
    const runDir = join(configDir, "orchestrator", "runs", "run-1");
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

    await recoverModule.default(["--dry-run"], baseOptions(configDir));

    expect(orchestratorRunCli).not.toHaveBeenCalled();
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
  name: string
): CliProjectConfig {
  return {
    projectId,
    slug: projectId,
    workspaceDir: join("/tmp", projectId),
    repositories: [
      {
        owner,
        name,
        cloneUrl: `https://github.com/${owner}/${name}.git`,
      },
    ],
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
  const configDir = await mkdtemp(join(tmpdir(), "cli-lifecycle-"));
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

async function writeStatusSnapshot(
  configDir: string,
  projectId: string,
  input: { slug: string; health: "idle" | "running" | "degraded" }
): Promise<void> {
  const statusDir = join(configDir, "orchestrator", "projects", projectId);
  await mkdir(statusDir, { recursive: true });
  await writeFile(
    join(statusDir, "status.json"),
    JSON.stringify(
      {
        slug: input.slug,
        health: input.health,
        lastTickAt: new Date().toISOString(),
        summary: {
          dispatched: 0,
          activeRuns: 0,
          suppressed: 0,
          recovered: 0,
        },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
        codexTotals: null,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

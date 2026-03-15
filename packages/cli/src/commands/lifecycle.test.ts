import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";

const orchestratorRunCli = vi.fn();
const spawnMock = vi.fn();

vi.mock("@gh-symphony/orchestrator", () => ({
  runCli: orchestratorRunCli,
}));

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

afterEach(() => {
  orchestratorRunCli.mockReset();
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

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

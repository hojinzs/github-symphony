import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliWorkspaceConfig } from "../config.js";

const orchestratorRunCli = vi.fn();
const spawnMock = vi.fn();

vi.mock("@gh-symphony/orchestrator", () => ({
  runCli: orchestratorRunCli,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process"
  );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const runModule = await import("./run.js");
const startModule = await import("./start.js");
const recoverModule = await import("./recover.js");

afterEach(() => {
  orchestratorRunCli.mockReset();
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("lifecycle command integration", () => {
  it("syncs the selected workspace config before single-issue dispatch", async () => {
    const configDir = await createConfigFixture({
      activeWorkspace: "workspace-a",
      workspaces: [
        createWorkspace("workspace-a", "acme", "platform"),
        createWorkspace("workspace-b", "beta", "api"),
      ],
    });

    await runModule.default(
      ["--workspace", "workspace-b", "beta/api#42"],
      baseOptions(configDir)
    );

    expect(orchestratorRunCli).toHaveBeenCalledWith([
      "run-issue",
      "--runtime-root",
      configDir,
      "--workspace-id",
      "workspace-b",
      "--issue",
      "beta/api#42",
    ]);

    const synced = JSON.parse(
      await readFile(
        join(
          configDir,
          "orchestrator",
          "workspaces",
          "workspace-b",
          "config.json"
        ),
        "utf8"
      )
    ) as CliWorkspaceConfig;
    expect(synced.workspaceId).toBe("workspace-b");
    expect(synced.repositories[0]).toMatchObject({
      owner: "beta",
      name: "api",
    });
  });

  it("starts the requested workspace in daemon mode", async () => {
    const configDir = await createConfigFixture({
      activeWorkspace: "workspace-a",
      workspaces: [
        createWorkspace("workspace-a", "acme", "platform"),
        createWorkspace("workspace-b", "beta", "api"),
      ],
    });

    spawnMock.mockReturnValue({
      pid: 4321,
      stdout: { pipe: vi.fn() },
      stderr: { pipe: vi.fn() },
      unref: vi.fn(),
    });

    await startModule.default(
      ["--workspace", "workspace-b", "--daemon"],
      baseOptions(configDir)
    );

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], "start", "--workspace", "workspace-b"],
      expect.objectContaining({
        env: expect.objectContaining({
          GH_SYMPHONY_CONFIG_DIR: configDir,
        }),
      })
    );
  });

  it("reports recoverable runs without invoking recovery in dry-run mode", async () => {
    const configDir = await createConfigFixture({
      activeWorkspace: "workspace-a",
      workspaces: [createWorkspace("workspace-a", "acme", "platform")],
    });
    const runDir = join(configDir, "orchestrator", "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify(
        {
          runId: "run-1",
          workspaceId: "workspace-a",
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

function createWorkspace(
  workspaceId: string,
  owner: string,
  name: string
): CliWorkspaceConfig {
  return {
    workspaceId,
    slug: workspaceId,
    promptGuidelines: "",
    repositories: [
      {
        owner,
        name,
        cloneUrl: `https://github.com/${owner}/${name}.git`,
      },
    ],
    tracker: {
      adapter: "github-project",
      bindingId: `${workspaceId}-project`,
      settings: {
        projectId: `${workspaceId}-project`,
        token: `${workspaceId}-token`,
      },
    },
    runtime: {
      driver: "local",
      workspaceRuntimeDir: join("/tmp", workspaceId),
      projectRoot: process.cwd(),
    },
  };
}

async function createConfigFixture(input: {
  activeWorkspace: string;
  workspaces: CliWorkspaceConfig[];
}): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "cli-lifecycle-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        activeWorkspace: input.activeWorkspace,
        token: `${input.activeWorkspace}-token`,
        workspaces: input.workspaces.map((workspace) => workspace.workspaceId),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const workspace of input.workspaces) {
    const workspaceDir = join(configDir, "workspaces", workspace.workspaceId);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "workspace.json"),
      JSON.stringify(workspace, null, 2) + "\n",
      "utf8"
    );
  }

  return configDir;
}

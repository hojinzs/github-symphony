import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";

const acquireProjectLock = vi.fn();
const releaseProjectLock = vi.fn();
const closeStatusServer = vi.fn();
const runOnce = vi.fn();
const status = vi.fn();

vi.mock("@gh-symphony/orchestrator", () => ({
  acquireProjectLock,
  releaseProjectLock,
  createStore: vi.fn(() => ({ kind: "store" })),
  OrchestratorService: class {
    runOnce = runOnce;
    status = status;
  },
  startOrchestratorStatusServer: vi.fn(() => ({
    listening: true,
    address: () => ({ address: "127.0.0.1", port: 4680, family: "IPv4" }),
    close: closeStatusServer,
  })),
}));

const startModule = await import("./start.js");

afterEach(() => {
  acquireProjectLock.mockReset();
  releaseProjectLock.mockReset();
  closeStatusServer.mockReset();
  runOnce.mockReset();
  status.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("shutdownForegroundOrchestrator", () => {
  it("exits even when removing the persisted status port fails", async () => {
    const close = vi.fn();
    const exit = vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? "undefined"}`);
    }) as unknown as (code?: number) => never;
    const removePortFile = vi
      .fn<typeof import("node:fs/promises").rm>()
      .mockRejectedValue(new Error("permission denied"));

    await expect(
      startModule.shutdownForegroundOrchestrator({
        configDir: "/tmp/gh-symphony",
        projectId: "tenant-a",
        statusServer: { close },
        exit,
        removePortFile,
      })
    ).rejects.toThrow("exit:0");

    expect(close).toHaveBeenCalledTimes(1);
    expect(removePortFile).toHaveBeenCalledTimes(1);
  });

  it("releases the project lock before exiting", async () => {
    const close = vi.fn();
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
        statusServer: { close },
        projectLock,
        releaseLock: releaseProjectLock,
        exit,
      })
    ).rejects.toThrow("exit:0");

    expect(releaseProjectLock).toHaveBeenCalledWith(projectLock);
  });
});

describe("start command foreground locking", () => {
  it("acquires and releases the project lock in foreground mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(
        configDir,
        "orchestrator",
        "projects",
        "tenant-a",
        ".lock"
      ),
      ownerToken: "owner",
      pid: 1234,
      startedAt: "2026-03-17T00:00:00.000Z",
    };
    acquireProjectLock.mockResolvedValue(lock);
    status.mockResolvedValue(null);
    runOnce.mockImplementation(async () => {
      process.emit("SIGINT");
      return {
        projectId: "tenant-a",
        slug: "tenant-a",
        health: "idle",
        lastTickAt: "2026-03-17T00:00:00.000Z",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      };
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => undefined) as (code?: number) => never);

    await startModule.default(["--project-id", "tenant-a"], baseOptions(configDir));

    expect(acquireProjectLock).toHaveBeenCalledWith({
      runtimeRoot: configDir,
      projectId: "tenant-a",
    });
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(closeStatusServer).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
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

function createProject(
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

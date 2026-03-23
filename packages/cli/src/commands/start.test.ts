import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";

const acquireProjectLock = vi.fn();
const releaseProjectLock = vi.fn();
const run = vi.fn();
const status = vi.fn();
const shutdown = vi.fn();
const requestReconcile = vi.fn();
const resolveDashboardResponse = vi.fn();
const serviceDependencies: Array<Record<string, unknown>> = [];

vi.mock("@gh-symphony/orchestrator", () => ({
  acquireProjectLock,
  releaseProjectLock,
  createStore: vi.fn(() => ({ kind: "store" })),
  resolveOrchestratorLogLevel: (value?: string | null) =>
    value === "verbose" ? "verbose" : "normal",
  OrchestratorService: class {
    constructor(
      _store: unknown,
      _projectConfig: unknown,
      dependencies: Record<string, unknown> = {}
    ) {
      serviceDependencies.push(dependencies);
    }
    run = run;
    status = status;
    shutdown = shutdown;
    requestReconcile = requestReconcile;
  },
}));

vi.mock("@gh-symphony/dashboard", () => ({
  DashboardFsReader: class {
    constructor(
      public runtimeRoot: string,
      public projectId: string
    ) {}
  },
  resolveDashboardResponse,
}));

const startModule = await import("./start.js");

beforeEach(() => {
  acquireProjectLock.mockReset();
  releaseProjectLock.mockReset();
  run.mockReset();
  status.mockReset();
  shutdown.mockReset();
  shutdown.mockResolvedValue(undefined);
  requestReconcile.mockReset();
  resolveDashboardResponse.mockReset();
  resolveDashboardResponse.mockImplementation(
    async ({ pathname, method }: { pathname: string; method?: string }) => ({
      status: 200,
      payload: { pathname, method: method ?? "GET" },
    })
  );
  serviceDependencies.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

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
  it("acquires and releases the project lock in foreground mode", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(
        configDir,
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
      .mockImplementation(((_code?: number) => undefined) as (code?: number) => never);

    await startModule.default(["--project-id", "tenant-a"], baseOptions(configDir));

    expect(acquireProjectLock).toHaveBeenCalledWith({
      runtimeRoot: configDir,
      projectId: "tenant-a",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("retries the foreground run loop after a service.run error", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(
        configDir,
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
    let attempts = 0;
    run.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient failure");
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
      .mockImplementation(((_code?: number) => undefined) as (code?: number) => never);

    await startModule.default(["--project-id", "tenant-a"], baseOptions(configDir));

    expect(run).toHaveBeenCalledTimes(2);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("serves dashboard routes and refresh over HTTP when --http is enabled", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, "projects", "tenant-a", ".lock"),
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
      .mockImplementation(((_code?: number) => undefined) as (code?: number) => never);
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--project-id", "tenant-a", "--http"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      await expect(
        fetch(`${url}/api/v1/state`).then((response) => response.json())
      ).resolves.toEqual({
        pathname: "/api/v1/state",
        method: "GET",
      });

      const refreshResponse = await fetch(`${url}/api/v1/refresh`, {
        method: "POST",
      });
      expect(refreshResponse.status).toBe(202);
      await expect(refreshResponse.json()).resolves.toEqual({ ok: true });
      expect(requestReconcile).toHaveBeenCalledTimes(1);

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

  it("increments the port when the requested HTTP port is already in use", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const lock = {
      lockPath: join(configDir, "projects", "tenant-a", ".lock"),
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

    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve())
    );
    const address = blocker.address();
    if (!address || typeof address === "string") {
      blocker.close();
      throw new Error("Expected TCP address");
    }

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as (code?: number) => never);
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--project-id", "tenant-a", "--http", String(address.port)],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      expect(new URL(url).port).toBe(String(address.port + 1));

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
      /HTTP dashboard listening on .*?(http:\/\/[^\s]+)/
    );
    if (match?.[1]) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for HTTP server log. Output: ${output()}`);
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

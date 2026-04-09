import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";
import * as configModule from "../config.js";

const acquireProjectLock = vi.fn();
const releaseProjectLock = vi.fn();
const run = vi.fn();
const status = vi.fn();
const shutdown = vi.fn();
const requestReconcile = vi.fn();
const resolveDashboardResponse = vi.fn();
const startControlPlaneServer = vi.fn();
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

vi.mock("@gh-symphony/control-plane", () => ({
  startControlPlaneServer,
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
  startControlPlaneServer.mockReset();
  resolveDashboardResponse.mockImplementation(
    async ({ pathname, method }: { pathname: string; method?: string }) => ({
      status: 200,
      payload: { pathname, method: method ?? "GET" },
    })
  );
  startControlPlaneServer.mockImplementation(async ({ port }: { port: number }) =>
    createMockControlPlaneStartResult(port)
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
  it("runs a single orchestration tick and exits naturally with --once", async () => {
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
      .mockImplementation(((_code?: number) => undefined) as (code?: number) => never);

    await startModule.default(
      ["--project-id", "tenant-a", "--once"],
      baseOptions(configDir)
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("rejects the conflicting --daemon --once combination", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const stderr = captureWrites(process.stderr);

    try {
      await startModule.default(
        ["--project-id", "tenant-a", "--daemon", "--once"],
        baseOptions(configDir)
      );
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
      await startModule.default(
        ["--project-id", "tenant-a", "--http", "--web"],
        baseOptions(configDir)
      );
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
      const httpState = JSON.parse(
        await readFile(
          join(
            configDir,
            "orchestrator",
            "workspaces",
            "tenant-a",
            "http.json"
          ),
          "utf8"
        )
      ) as { host: string; port: number; endpoint: string };
      expect(httpState).toEqual({
        host: "0.0.0.0",
        port: Number.parseInt(new URL(url).port, 10),
        endpoint: url,
      });
      await expect(
        fetch(`${url}/api/v1/state`).then((response) => response.json())
      ).resolves.toEqual({
        pathname: "/api/v1/state",
        method: "GET",
      });

      const refreshResponse = await fetch(`${url}/api/v1/refresh`, {
        method: "POST",
        body: JSON.stringify({ reason: "manual" }),
        headers: {
          "content-type": "application/json",
        },
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
      await expect(
        readFile(
          join(
            configDir,
            "orchestrator",
            "workspaces",
            "tenant-a",
            "http.json"
          ),
          "utf8"
        )
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
  });

  it("starts the control plane server when --web is enabled", async () => {
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
        ["--project-id", "tenant-a", "--web"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      expect(startControlPlaneServer).toHaveBeenCalledWith({
        host: "0.0.0.0",
        port: 4680,
        runtimeRoot: configDir,
        projectId: "tenant-a",
        onRefreshRequest: expect.any(Function),
      });

      const httpState = JSON.parse(
        await readFile(
          join(
            configDir,
            "orchestrator",
            "workspaces",
            "tenant-a",
            "http.json"
          ),
          "utf8"
        )
      ) as { host: string; port: number; endpoint: string };
      expect(httpState).toEqual({
        host: "0.0.0.0",
        port: Number.parseInt(new URL(url).port, 10),
        endpoint: url,
      });
      expect(stdout.output()).toContain("Web dashboard listening on");

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
      await expect(
        readFile(
          join(
            configDir,
            "orchestrator",
            "workspaces",
            "tenant-a",
            "http.json"
          ),
          "utf8"
        )
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(releaseProjectLock).toHaveBeenCalledWith(lock);
    expect(resolveDashboardResponse).not.toHaveBeenCalled();
  });

  it("passes an explicit port to the control plane server", async () => {
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

    const startPromise = startModule.default(
      ["--project-id", "tenant-a", "--web", "4900"],
      baseOptions(configDir)
    );

    await vi.waitFor(() => {
      expect(startControlPlaneServer).toHaveBeenCalledWith({
        host: "0.0.0.0",
        port: 4900,
        runtimeRoot: configDir,
        projectId: "tenant-a",
        onRefreshRequest: expect.any(Function),
      });
    });

    process.emit("SIGINT");
    await startPromise;

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("keeps the HTTP dashboard available after a one-shot tick until interrupted", async () => {
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
    run.mockImplementation(
      async (options?: { once?: boolean }) => {
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
      }
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as (code?: number) => never);
    const stdout = captureWrites(process.stdout);

    try {
      const startPromise = startModule.default(
        ["--project-id", "tenant-a", "--once", "--http"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      await expect(fetchJsonWithRetry(`${url}/api/v1/state`)).resolves.toEqual({
        pathname: "/api/v1/state",
        method: "GET",
      });
      expect(stdout.output()).toContain(
        "One-shot tick completed; HTTP dashboard remains available until Ctrl+C"
      );

      process.emit("SIGINT");
      await startPromise;
      await expect(
        readFile(
          join(
            configDir,
            "orchestrator",
            "workspaces",
            "tenant-a",
            "http.json"
          ),
          "utf8"
        )
      ).rejects.toMatchObject({ code: "ENOENT" });
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
    resolveDashboardResponse.mockRejectedValue(new Error("reader exploded"));

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as (code?: number) => never);
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      const startPromise = startModule.default(
        ["--project-id", "tenant-a", "--http"],
        baseOptions(configDir)
      );

      const url = await waitForHttpUrl(stdout.output);
      const response = await fetch(`${url}/api/v1/state`);
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
      blocker.listen(0, "0.0.0.0", () => resolve())
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

  it("keeps an existing http.json when lock acquisition fails", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a", "acme", "platform")],
    });
    const statePath = join(
      configDir,
      "orchestrator",
      "workspaces",
      "tenant-a",
      "http.json"
    );
    await mkdir(join(configDir, "orchestrator", "workspaces", "tenant-a"), {
      recursive: true,
    });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          host: "0.0.0.0",
          port: 4680,
          endpoint: "http://localhost:4680",
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    acquireProjectLock.mockRejectedValue(new Error("lock busy"));

    await expect(
      startModule.default(["--project-id", "tenant-a"], baseOptions(configDir))
    ).rejects.toThrow("lock busy");

    await expect(readFile(statePath, "utf8")).resolves.toContain(
      "\"endpoint\": \"http://localhost:4680\""
    );
  });

  it("warns and keeps running when http.json persistence fails", async () => {
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
    vi.spyOn(configModule, "writeJsonFile").mockRejectedValueOnce(
      new Error("disk full")
    );
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
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(stdout.output()).toContain(
        "Failed to persist HTTP binding state (http.json): disk full"
      );

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
      /(HTTP|Web) dashboard listening on .*?(http:\/\/[^\s]+)/
    );
    if (match?.[2]) {
      return match[2];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for HTTP server log. Output: ${output()}`);
}

async function createMockControlPlaneStartResult(port: number): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
}> {
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve());
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
      const response = await fetch(url);
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

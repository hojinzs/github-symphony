import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import type { OrchestratorLogLevel } from "./service.js";
import type { OrchestratorService } from "./service.js";

function createMockService(): OrchestratorService {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    runOnce: vi.fn().mockResolvedValue({
      projectId: "tenant-1",
      slug: "tenant-1",
      tracker: { adapter: "github-project", bindingId: "project-123" },
      lastTickAt: "2026-03-09T00:00:00.000Z",
      health: "idle",
      summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
      activeRuns: [],
      retryQueue: [],
      lastError: null,
    }),
    status: vi.fn().mockResolvedValue(null),
    shutdown: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue({
      projectId: "tenant-1",
      slug: "tenant-1",
      tracker: { adapter: "github-project", bindingId: "project-123" },
      lastTickAt: "2026-03-09T00:00:00.000Z",
      health: "idle",
      summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
      activeRuns: [],
      retryQueue: [],
      lastError: null,
    }),
  } as unknown as OrchestratorService;
}

function createStdoutCapture(): {
  write: (chunk: string) => boolean;
  output: () => string;
} {
  let buffer = "";
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    output: () => buffer,
  };
}

function createFakeStatusServer(
  address: { address: string; port: number; family: string },
  options: {
    onClose?: (callback?: (error?: Error) => void) => void;
  } = {}
) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    address: () => address,
    close: (callback?: (error?: Error) => void) => {
      options.onClose?.(callback);
      if (!options.onClose) {
        callback?.();
      }
      return emitter;
    },
  });
}

describe("CLI --no-status-api flag", () => {
  it("passes --log-level verbose to service creation", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const service = createMockService();
    const createService = vi.fn<
      (
        runtimeRoot: string,
        projectId?: string,
        options?: {
          eventsDir?: string;
          logLevel: OrchestratorLogLevel;
          stderr: Pick<NodeJS.WriteStream, "write">;
        }
      ) => OrchestratorService
    >(() => service);

    await runCli(
      [
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
        "--log-level",
        "verbose",
      ],
      {
        createService,
      }
    );

    expect(createService).toHaveBeenCalledWith(
      runtimeRoot,
      "tenant-1",
      expect.objectContaining({
        logLevel: "verbose",
        eventsDir: undefined,
      })
    );
  });

  it("passes --events-dir to service creation", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const service = createMockService();
    const eventsDir = join(runtimeRoot, "evidence");
    const createService = vi.fn<
      (
        runtimeRoot: string,
        projectId?: string,
        options?: {
          eventsDir?: string;
          logLevel: OrchestratorLogLevel;
          stderr: Pick<NodeJS.WriteStream, "write">;
        }
      ) => OrchestratorService
    >(() => service);

    await runCli(
      [
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
        "--events-dir",
        eventsDir,
      ],
      {
        createService,
      }
    );

    expect(createService).toHaveBeenCalledWith(
      runtimeRoot,
      "tenant-1",
      expect.objectContaining({
        eventsDir,
      })
    );
  });

  it("uses SYMPHONY_EVENTS_DIR when --events-dir is omitted", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const service = createMockService();
    const eventsDir = join(runtimeRoot, "evidence");
    const createService = vi.fn<
      (
        runtimeRoot: string,
        projectId?: string,
        options?: {
          eventsDir?: string;
          logLevel: OrchestratorLogLevel;
          stderr: Pick<NodeJS.WriteStream, "write">;
        }
      ) => OrchestratorService
    >(() => service);

    process.env.SYMPHONY_EVENTS_DIR = eventsDir;
    try {
      await runCli(
        [
          "run",
          "--no-status-api",
          "--runtime-root",
          runtimeRoot,
          "--project-id",
          "tenant-1",
        ],
        {
          createService,
        }
      );
    } finally {
      delete process.env.SYMPHONY_EVENTS_DIR;
    }

    expect(createService).toHaveBeenCalledWith(
      runtimeRoot,
      "tenant-1",
      expect.objectContaining({
        eventsDir,
      })
    );
  });

  it("uses SYMPHONY_LOG_LEVEL when --log-level is omitted", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const service = createMockService();
    const createService = vi.fn<
      (
        runtimeRoot: string,
        projectId?: string,
        options?: {
          eventsDir?: string;
          logLevel: OrchestratorLogLevel;
          stderr: Pick<NodeJS.WriteStream, "write">;
        }
      ) => OrchestratorService
    >(() => service);

    process.env.SYMPHONY_LOG_LEVEL = "verbose";
    try {
      await runCli(
        [
          "run",
          "--no-status-api",
          "--runtime-root",
          runtimeRoot,
          "--project-id",
          "tenant-1",
        ],
        {
          createService,
        }
      );
    } finally {
      delete process.env.SYMPHONY_LOG_LEVEL;
    }

    expect(createService).toHaveBeenCalledWith(
      runtimeRoot,
      "tenant-1",
      expect.objectContaining({
        logLevel: "verbose",
        eventsDir: undefined,
      })
    );
  });

  it("rejects --events-dir without a value", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));

    await expect(
      runCli([
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
        "--events-dir",
      ])
    ).rejects.toThrow("Option '--events-dir' argument missing");
  });

  it("rejects --log-level without a value", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));

    await expect(
      runCli([
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
        "--log-level",
      ])
    ).rejects.toThrow("Option '--log-level' argument missing");
  });

  it("describes supported log levels in validation errors", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));

    await expect(
      runCli([
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
        "--log-level",
        "loud",
      ])
    ).rejects.toThrow(
      "Unsupported log level: loud. Supported values: normal, verbose."
    );
  });

  it("does not start the status server when --no-status-api is set", async () => {
    const startStatusServer = vi.fn();
    const service = createMockService();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));

    await runCli(
      [
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
      ],
      {
        createService: () => service,
        startStatusServer: startStatusServer as never,
      }
    );

    expect(startStatusServer).not.toHaveBeenCalled();
    expect(service.run).toHaveBeenCalledTimes(1);
  });

  it("starts the status server by default and prints the listening address", async () => {
    const fakeServer = createFakeStatusServer({
      address: "127.0.0.1",
      port: 4680,
      family: "IPv4",
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fakeServer.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(
      ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
      {
        createService: () => service,
        startStatusServer: startStatusServer as never,
        stdout,
      }
    );

    expect(startStatusServer).toHaveBeenCalledTimes(1);
    expect(startStatusServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 0,
        onRefresh: expect.any(Function),
      })
    );
    expect(stdout.output()).toContain(
      "Status server listening on http://127.0.0.1:4680"
    );
  });

  it("wires the refresh endpoint to service.runOnce", async () => {
    const fakeServer = createFakeStatusServer({
      address: "127.0.0.1",
      port: 4680,
      family: "IPv4",
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fakeServer.emit("listening");
    });

    await runCli(
      [
        "run",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
        "--issue",
        "acme/repo#1",
      ],
      {
        createService: () => service,
        startStatusServer: startStatusServer as never,
        stdout: createStdoutCapture(),
      }
    );

    const options = startStatusServer.mock.calls[0]?.[0] as {
      onRefresh: () => Promise<void>;
    };
    await options.onRefresh();

    expect(service.runOnce).toHaveBeenCalledWith({
      issueIdentifier: "acme/repo#1",
    });
  });

  it("normalises wildcard addresses to localhost in the log line", async () => {
    const fakeServer = createFakeStatusServer({
      address: "0.0.0.0",
      port: 9999,
      family: "IPv4",
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fakeServer.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(
      ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
      {
        createService: () => service,
        startStatusServer: startStatusServer as never,
        stdout,
      }
    );

    expect(stdout.output()).toContain(
      "Status server listening on http://localhost:9999"
    );
  });

  it("normalises IPv6 wildcard to localhost in the log line", async () => {
    const fakeServer = createFakeStatusServer({
      address: "::",
      port: 4680,
      family: "IPv6",
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fakeServer.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(
      ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
      {
        createService: () => service,
        startStatusServer: startStatusServer as never,
        stdout,
      }
    );

    expect(stdout.output()).toContain(
      "Status server listening on http://localhost:4680"
    );
  });

  it("forwards --status-host and --status-port to the status server", async () => {
    const fakeServer = createFakeStatusServer({
      address: "10.0.0.5",
      port: 8080,
      family: "IPv4",
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fakeServer.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(
      [
        "run",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
        "--status-host",
        "10.0.0.5",
        "--status-port",
        "8080",
      ],
      {
        createService: () => service,
        startStatusServer: startStatusServer as never,
        stdout,
      }
    );

    expect(startStatusServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "10.0.0.5",
        port: 8080,
      })
    );
    expect(stdout.output()).toContain(
      "Status server listening on http://10.0.0.5:8080"
    );
  });

  it("gracefully shuts down on SIGTERM", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const signalTarget = new EventEmitter();
    const exitProcess = vi.fn();
    const service = createMockService();
    let resolveRun: (() => void) | null = null;
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    (service.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      resolveRun?.();
    });

    const runPromise = runCli(
      [
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
      ],
      {
        createService: () => service,
        exitProcess,
        signalTarget: signalTarget as unknown as Pick<
          NodeJS.Process,
          "once" | "off"
        >,
      }
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (signalTarget.listenerCount("SIGTERM") === 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(signalTarget.listenerCount("SIGTERM")).toBe(1);
    signalTarget.emit("SIGTERM");
    await runPromise;

    expect(service.shutdown).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(0);
    await expect(
      access(join(runtimeRoot, "projects", "tenant-1", ".lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the project lock and exits non-zero when cleanup fails on SIGTERM", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const signalTarget = new EventEmitter();
    const exitProcess = vi.fn();
    const stderr = createStdoutCapture();
    const service = createMockService();
    const fakeServer = createFakeStatusServer(
      {
        address: "127.0.0.1",
        port: 4680,
        family: "IPv4",
      },
      {
        onClose: (callback) => {
          queueMicrotask(() => {
            callback?.(new Error("close failed"));
          });
        },
      }
    );
    let resolveRun: (() => void) | null = null;
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    (service.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      resolveRun?.();
    });

    const runPromise = runCli(
      ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
      {
        createService: () => service,
        startStatusServer: () => fakeServer as never,
        exitProcess,
        signalTarget: signalTarget as unknown as Pick<
          NodeJS.Process,
          "once" | "off"
        >,
        stderr,
      }
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (signalTarget.listenerCount("SIGTERM") === 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    signalTarget.emit("SIGTERM");
    await expect(runPromise).rejects.toThrow("close failed");

    expect(service.shutdown).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(stderr.output()).toContain(
      "Failed to shut down orchestrator after SIGTERM: close failed"
    );
    await expect(
      access(join(runtimeRoot, "projects", "tenant-1", ".lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the project lock after the run finishes", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const service = createMockService();

    await runCli(
      [
        "run",
        "--no-status-api",
        "--runtime-root",
        runtimeRoot,
        "--project-id",
        "tenant-1",
      ],
      {
        createService: () => service,
      }
    );

    await expect(
      access(join(runtimeRoot, "projects", "tenant-1", ".lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before running the service when the project lock belongs to a live pid", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const service = createMockService();
    await mkdir(join(runtimeRoot, "projects", "tenant-1"), {
      recursive: true,
    });
    await writeFile(
      join(runtimeRoot, "projects", "tenant-1", ".lock"),
      JSON.stringify({
        ownerToken: "existing-owner",
        pid: process.pid,
        startedAt: "2026-03-16T00:00:00.000Z",
      }) + "\n",
      "utf8"
    );

    await expect(
      runCli(
        [
          "run",
          "--no-status-api",
          "--runtime-root",
          runtimeRoot,
          "--project-id",
          "tenant-1",
        ],
        {
          createService: () => service,
        }
      )
    ).rejects.toThrow(
      `Project "tenant-1" is already running (PID ${process.pid}).`
    );

    expect(service.run).not.toHaveBeenCalled();
  });

  it("rejects invalid project ids before creating the service", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const createService = vi.fn(() => createMockService());

    await expect(
      runCli(
        [
          "run",
          "--no-status-api",
          "--runtime-root",
          runtimeRoot,
          "--project-id",
          "../tenant-1",
        ],
        {
          createService,
        }
      )
    ).rejects.toThrow('Invalid project ID "../tenant-1"');

    expect(createService).not.toHaveBeenCalled();
  });
});

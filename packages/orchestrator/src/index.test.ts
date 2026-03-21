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

describe("orchestrator CLI", () => {
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
        ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
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
        ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
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
      })
    );
  });

  it("rejects --events-dir without a value", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));

    await expect(
      runCli([
        "run",
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
      ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
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

  it("releases the project lock after the run finishes", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-cli-"));
    const service = createMockService();

    await runCli(
      ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
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
        ["run", "--runtime-root", runtimeRoot, "--project-id", "tenant-1"],
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

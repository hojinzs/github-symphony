import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
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

describe("CLI --no-status-api flag", () => {
  it("does not start the status server when --no-status-api is set", async () => {
    const startStatusServer = vi.fn();
    const service = createMockService();

    await runCli(["run", "--no-status-api"], {
      createService: () => service,
      startStatusServer: startStatusServer as never,
    });

    expect(startStatusServer).not.toHaveBeenCalled();
    expect(service.run).toHaveBeenCalledTimes(1);
  });

  it("starts the status server by default and prints the listening address", async () => {
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      address: () => ({ address: "127.0.0.1", port: 4680, family: "IPv4" }),
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      emitter.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(["run"], {
      createService: () => service,
      startStatusServer: startStatusServer as never,
      stdout,
    });

    expect(startStatusServer).toHaveBeenCalledTimes(1);
    expect(startStatusServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 4680,
        onRefresh: expect.any(Function),
      })
    );
    expect(stdout.output()).toContain(
      "Status server listening on http://127.0.0.1:4680"
    );
  });

  it("wires the refresh endpoint to service.runOnce", async () => {
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      address: () => ({ address: "127.0.0.1", port: 4680, family: "IPv4" }),
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      emitter.emit("listening");
    });

    await runCli(["run", "--project-id", "tenant-1", "--issue", "acme/repo#1"], {
      createService: () => service,
      startStatusServer: startStatusServer as never,
      stdout: createStdoutCapture(),
    });

    const options = startStatusServer.mock.calls[0]?.[0] as {
      onRefresh: () => Promise<void>;
    };
    await options.onRefresh();

    expect(service.runOnce).toHaveBeenCalledWith({
      issueIdentifier: "acme/repo#1",
    });
  });

  it("normalises wildcard addresses to localhost in the log line", async () => {
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      address: () => ({ address: "0.0.0.0", port: 9999, family: "IPv4" }),
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      emitter.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(["run"], {
      createService: () => service,
      startStatusServer: startStatusServer as never,
      stdout,
    });

    expect(stdout.output()).toContain(
      "Status server listening on http://localhost:9999"
    );
  });

  it("normalises IPv6 wildcard to localhost in the log line", async () => {
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      address: () => ({ address: "::", port: 4680, family: "IPv6" }),
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      emitter.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(["run"], {
      createService: () => service,
      startStatusServer: startStatusServer as never,
      stdout,
    });

    expect(stdout.output()).toContain(
      "Status server listening on http://localhost:4680"
    );
  });

  it("forwards --status-host and --status-port to the status server", async () => {
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      address: () => ({ address: "10.0.0.5", port: 8080, family: "IPv4" }),
    });
    const startStatusServer = vi.fn().mockReturnValue(fakeServer);
    const service = createMockService();
    (service.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      emitter.emit("listening");
    });
    const stdout = createStdoutCapture();

    await runCli(
      ["run", "--status-host", "10.0.0.5", "--status-port", "8080"],
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
});

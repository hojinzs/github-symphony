import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { GlobalOptions } from "../index.js";
import { daemonPidPath, orchestratorLogPath } from "../config.js";
import {
  OrchestratorService,
  acquireProjectLock,
  createStore,
  releaseProjectLock,
  resolveOrchestratorLogLevel,
  type OrchestratorLogLevel,
  type ProjectLockHandle,
} from "@gh-symphony/orchestrator";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";
import {
  DashboardFsReader,
  resolveDashboardResponse,
} from "@gh-symphony/dashboard";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";
import { bold, dim, green, red, yellow, cyan, setNoColor } from "../ansi.js";
import { getGhToken } from "../github/gh-auth.js";

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return dim(`${hh}:${mm}:${ss}`);
}

function logLine(icon: string, msg: string): void {
  process.stdout.write(`${timestamp()} ${icon} ${msg}\n`);
}

type ForegroundShutdownOptions = {
  configDir: string;
  projectId: string;
  httpServer?: Server;
  projectLock?: ProjectLockHandle | null;
  service?: { shutdown(): Promise<void> };
  exit?: (code?: number) => never;
  releaseLock?: typeof releaseProjectLock;
};

const DEFAULT_HTTP_PORT = 4680;
const HTTP_HOST = "0.0.0.0";

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseStartArgs(args: string[]): {
  daemon: boolean;
  httpPort?: number;
  projectId?: string;
  logLevel?: string;
  error?: string;
} {
  const parsed: {
    daemon: boolean;
    httpPort?: number;
    projectId?: string;
    logLevel?: string;
    error?: string;
  } = {
    daemon: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--daemon" || arg === "-d") {
      parsed.daemon = true;
      continue;
    }
    if (arg === "--http") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.httpPort = DEFAULT_HTTP_PORT;
        continue;
      }
      parsed.httpPort = parsePort(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--project" || arg === "--project-id") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.projectId = value;
      i += 1;
      continue;
    }
    if (arg === "--log-level") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.logLevel = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }
  }

  return parsed;
}

// ── Tick logging ──────────────────────────────────────────────────────────────

function logTickResult(
  snapshot: ProjectStatusSnapshot,
  prevSnapshot: ProjectStatusSnapshot | null,
  isFirst: boolean
): void {
  if (isFirst) {
    const healthColor =
      snapshot.health === "degraded"
        ? red
        : snapshot.health === "running"
          ? green
          : cyan;
    logLine(
      green("\u25CF"),
      `Project ${bold(snapshot.slug)} connected ${dim("(")}${healthColor(snapshot.health)}${dim(")")}`
    );
    if (snapshot.summary.activeRuns > 0) {
      logLine(cyan("\u25B8"), `${snapshot.summary.activeRuns} active run(s)`);
    }
    return;
  }

  if (prevSnapshot && prevSnapshot.health !== snapshot.health) {
    const icon =
      snapshot.health === "degraded" ? red("\u25CF") : green("\u25CF");
    logLine(
      icon,
      `Health changed: ${prevSnapshot.health} \u2192 ${bold(snapshot.health)}`
    );
  }

  if (snapshot.lastError && snapshot.lastError !== prevSnapshot?.lastError) {
    logLine(red("\u2717"), red(snapshot.lastError));
  }

  if (!snapshot.lastError && prevSnapshot?.lastError) {
    logLine(green("\u2713"), green("Error cleared"));
  }

  const prevDispatched = prevSnapshot?.summary.dispatched ?? 0;
  if (snapshot.summary.dispatched > prevDispatched) {
    const delta = snapshot.summary.dispatched - prevDispatched;
    logLine(yellow("\u25B8"), `Dispatched ${bold(String(delta))} new run(s)`);
  }

  const prevRunIds = new Set(
    prevSnapshot?.activeRuns.map((run) => run.runId) ?? []
  );
  for (const run of snapshot.activeRuns) {
    if (!prevRunIds.has(run.runId)) {
      logLine(
        cyan("\u25B8"),
        `Run started: ${bold(run.issueIdentifier)} ${dim("state=")}${run.issueState} ${dim("status=")}${run.status}`
      );
    }
  }

  const currentRunIds = new Set(snapshot.activeRuns.map((run) => run.runId));
  for (const prevRun of prevSnapshot?.activeRuns ?? []) {
    if (!currentRunIds.has(prevRun.runId)) {
      logLine(
        green("\u2713"),
        `Run finished: ${bold(prevRun.issueIdentifier)} ${dim("(")}${prevRun.status}${dim(")")}`
      );
    }
  }

  const prevSuppressed = prevSnapshot?.summary.suppressed ?? 0;
  if (snapshot.summary.suppressed > prevSuppressed) {
    const delta = snapshot.summary.suppressed - prevSuppressed;
    logLine(
      dim("\u25CB"),
      dim(`${delta} issue(s) suppressed (already running or at limit)`)
    );
  }

  const prevRecovered = prevSnapshot?.summary.recovered ?? 0;
  if (snapshot.summary.recovered > prevRecovered) {
    const delta = snapshot.summary.recovered - prevRecovered;
    logLine(
      yellow("\u21BA"),
      `Recovered ${bold(String(delta))} stalled run(s)`
    );
  }

  const prevRetryCount = prevSnapshot?.retryQueue.length ?? 0;
  if (snapshot.retryQueue.length > prevRetryCount) {
    const delta = snapshot.retryQueue.length - prevRetryCount;
    logLine(yellow("\u25CC"), `${delta} run(s) queued for retry`);
  }

  const changed =
    snapshot.health !== prevSnapshot?.health ||
    snapshot.lastError !== prevSnapshot?.lastError ||
    snapshot.summary.dispatched !== prevSnapshot?.summary.dispatched ||
    snapshot.summary.suppressed !== prevSnapshot?.summary.suppressed ||
    snapshot.summary.recovered !== prevSnapshot?.summary.recovered ||
    snapshot.activeRuns.length !== (prevSnapshot?.activeRuns.length ?? 0) ||
    snapshot.retryQueue.length !== (prevSnapshot?.retryQueue.length ?? 0);

  if (!changed) {
    logLine(
      dim("\u00B7"),
      dim(
        `tick \u2014 ${snapshot.summary.activeRuns} active, ${snapshot.health}`
      )
    );
  }
}

function parsePort(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Option '${optionName}' must be an integer port number`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      `Option '${optionName}' must be a port number between 0 and 65535`
    );
  }

  return parsed;
}

function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function formatBoundUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    return `http://${HTTP_HOST}`;
  }

  const host =
    address.address === "::" || address.address === "0.0.0.0"
      ? "localhost"
      : address.address;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${address.port}`;
}

async function closeHttpServer(server?: Server): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function startHttpServer(input: {
  runtimeRoot: string;
  projectId: string;
  initialPort: number;
  service: { requestReconcile(): void };
}): Promise<{ server: Server; port: number; url: string }> {
  const reader = new DashboardFsReader(input.runtimeRoot, input.projectId);

  for (let port = input.initialPort; port <= 65_535; port += 1) {
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const url = new URL(request.url ?? "/", `http://${HTTP_HOST}`);
          if (
            request.method === "POST" &&
            url.pathname === "/api/v1/refresh"
          ) {
            input.service.requestReconcile();
            respondJson(response, 202, { ok: true });
            return;
          }

          const resolved = await resolveDashboardResponse({
            pathname: url.pathname,
            method: request.method ?? "GET",
            reader,
          });
          respondJson(response, resolved.status, resolved.payload);
        } catch (error) {
          if (!response.headersSent) {
            respondJson(response, 500, {
              error:
                error instanceof Error ? error.message : "Internal server error",
            });
          } else {
            response.end();
          }
        }
      })();
    });

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const handleListening = () => {
          cleanup();
          resolveReady();
        };
        const handleError = (error: NodeJS.ErrnoException) => {
          cleanup();
          rejectReady(error);
        };
        const cleanup = () => {
          server.off("listening", handleListening);
          server.off("error", handleError);
        };

        server.once("listening", handleListening);
        server.once("error", handleError);
        server.listen(port, HTTP_HOST);
      });

      return {
        server,
        port,
        url: formatBoundUrl(server),
      };
    } catch (error) {
      await closeHttpServer(server).catch(() => {});
      if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Unable to bind HTTP server starting from port ${input.initialPort}`
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  setNoColor(options.noColor);
  let parsed: ReturnType<typeof parseStartArgs>;
  try {
    parsed = parseStartArgs(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid arguments"}\n`
    );
    process.exitCode = 2;
    return;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony start --project-id <project-id> [--daemon] [--http [port]]\n"
    );
    process.exitCode = 2;
    return;
  }
  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: parsed.projectId,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig();
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const projectId = projectConfig.projectId;
  let logLevel: OrchestratorLogLevel;
  try {
    logLevel = resolveOrchestratorLogLevel(
      parsed.logLevel ?? process.env.SYMPHONY_LOG_LEVEL
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unsupported log level"}\n`
    );
    process.exitCode = 2;
    return;
  }
  if (parsed.daemon) {
    await startDaemon(options, projectId, parsed.logLevel, parsed.httpPort);
    return;
  }

  // ── 5.1: Foreground mode with live logging ────────────────────────────────
  if (!process.env.GITHUB_GRAPHQL_TOKEN) {
    try {
      process.env.GITHUB_GRAPHQL_TOKEN = getGhToken();
    } catch {
      // gh CLI not installed/authenticated — GITHUB_GRAPHQL_TOKEN stays unset
      // Workers will fail if token is needed but not available
    }
  }

  let projectLock: ProjectLockHandle | null = null;
  try {
    projectLock = await acquireProjectLock({
      runtimeRoot,
      projectId,
    });

    const store = createStore(runtimeRoot);
    let prevSnapshot: ProjectStatusSnapshot | null = null;
    let isFirst = true;
    const service = new OrchestratorService(store, projectConfig, {
      logLevel,
      onTick: async (snapshot) => {
        try {
          logTickResult(snapshot, prevSnapshot, isFirst);

          if (!isFirst) {
            const currentRunIds = new Set(
              snapshot.activeRuns.map((run) => run.runId)
            );
            for (const prevRun of prevSnapshot?.activeRuns ?? []) {
              if (!currentRunIds.has(prevRun.runId)) {
                await tailWorkerLog(
                  runtimeRoot,
                  projectId,
                  prevRun.runId,
                  prevRun.issueIdentifier
                );
              }
            }
          }

          prevSnapshot = snapshot;
          isFirst = false;
        } catch (error) {
          logLine(
            red("\u2717"),
            red(
              `Tick error: ${error instanceof Error ? error.message : "Unknown error"}`
            )
          );
        }
      },
    });
    const httpServer =
      parsed.httpPort !== undefined
        ? await startHttpServer({
            runtimeRoot,
            projectId,
            initialPort: parsed.httpPort,
            service,
          })
        : null;

    logLine(
      green("\u25B2"),
      `Starting orchestrator for project: ${bold(projectId)}`
    );
    if (httpServer) {
      logLine(
        cyan("\u25A1"),
        `HTTP dashboard listening on ${httpServer.url}`
      );
    }
    logLine(dim("\u00B7"), dim("Press Ctrl+C to stop"));

    let shuttingDown = false;
    let shutdownPromise: Promise<never> | null = null;
    const shutdown = async () => {
      if (shuttingDown) {
        return shutdownPromise;
      }
      shuttingDown = true;
      const heldLock = projectLock;
      projectLock = null;
      shutdownPromise = shutdownForegroundOrchestrator({
        configDir: options.configDir,
        projectId,
        httpServer: httpServer?.server,
        projectLock: heldLock,
        service,
      });
      return shutdownPromise;
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });

    try {
      while (!shuttingDown) {
        try {
          await service.run();
          break;
        } catch (error) {
          if (shuttingDown) {
            break;
          }

          logLine(
            red("\u2717"),
            red(
              `Run loop error: ${error instanceof Error ? error.message : "Unknown error"}`
            )
          );
        }
      }
    } finally {
      if (shutdownPromise) {
        await shutdownPromise;
      }
    }
  } finally {
    await releaseProjectLock(projectLock);
  }
};

export async function shutdownForegroundOrchestrator(
  input: ForegroundShutdownOptions
): Promise<never> {
  logLine(yellow("\u25BC"), "Shutting down...");

  // Drain active workers before tearing down infrastructure so that child
  // processes receive SIGTERM/SIGKILL and do not become orphans.
  if (input.service) {
    try {
      await input.service.shutdown();
    } catch (error) {
      logLine(
        red("\u2717"),
        red(
          `Failed to shut down workers: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      );
    }
  }

  try {
    await closeHttpServer(input.httpServer);
  } catch (error) {
    logLine(
      yellow("\u26A0"),
      `Failed to stop HTTP server: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  try {
    await (input.releaseLock ?? releaseProjectLock)(input.projectLock);
  } catch (error) {
    logLine(
      yellow("\u26A0"),
      `Failed to release project lock: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  return (input.exit ?? process.exit)(0);
}

async function tailWorkerLog(
  runtimeRoot: string,
  projectId: string,
  runId: string,
  issueIdentifier: string
): Promise<void> {
  try {
    const logPath = join(runtimeRoot, "projects", projectId, "runs", runId, "worker.log");
    const content = await readFile(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return;
    const tail = lines.slice(-30);
    logLine(red("\u2717"), red(`Worker stderr (${issueIdentifier}):`));
    for (const line of tail) {
      process.stdout.write(`  ${dim(line)}\n`);
    }
  } catch {
    // worker.log 없거나 읽기 실패 시 무시
  }
}

export default handler;

// ── 5.2: Daemon mode ─────────────────────────────────────────────────────────

async function startDaemon(
  options: GlobalOptions,
  projectId: string,
  logLevel?: string,
  httpPort?: number
): Promise<void> {
  const logPath = orchestratorLogPath(options.configDir, projectId);
  await mkdir(dirname(logPath), { recursive: true });

  const { openSync } = await import("node:fs");
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [
      process.argv[1]!,
      "start",
      "--project",
      projectId,
      ...(httpPort !== undefined ? ["--http", String(httpPort)] : []),
      ...(logLevel ? ["--log-level", logLevel] : []),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GH_SYMPHONY_CONFIG_DIR: options.configDir,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );

  const pidPath = daemonPidPath(options.configDir, projectId);
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(child.pid), "utf8");

  child.unref();

  const { closeSync } = await import("node:fs");
  closeSync(logFd);

  process.stdout.write(
    `Orchestrator started in background (PID: ${child.pid}).\n` +
      `Logs: ${logPath}\n` +
      `Stop with: gh-symphony project stop --project-id ${projectId}\n`
  );
}

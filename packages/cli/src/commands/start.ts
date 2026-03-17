import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { GlobalOptions } from "../index.js";
import {
  daemonPidPath,
  orchestratorLogPath,
  orchestratorPortPath,
} from "../config.js";
import {
  OrchestratorService,
  acquireProjectLock,
  createStore,
  releaseProjectLock,
  startOrchestratorStatusServer,
  type ProjectLockHandle,
} from "@gh-symphony/orchestrator";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";
import {
  resolveRuntimeRoot,
  syncProjectToRuntime,
} from "../orchestrator-runtime.js";
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
  statusServer: { close(): void };
  projectLock?: ProjectLockHandle | null;
  exit?: (code?: number) => never;
  removePortFile?: typeof rm;
  releaseLock?: typeof releaseProjectLock;
};

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseStartArgs(args: string[]): {
  daemon: boolean;
  projectId?: string;
  error?: string;
} {
  const parsed: { daemon: boolean; projectId?: string; error?: string } = {
    daemon: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--daemon" || arg === "-d") {
      parsed.daemon = true;
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

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  setNoColor(options.noColor);
  const parsed = parseStartArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony start --project-id <project-id> [--daemon]\n"
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
  await syncProjectToRuntime(options.configDir, projectConfig);

  if (parsed.daemon) {
    await startDaemon(options, projectId);
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
    const service = new OrchestratorService(store, projectConfig);

    const statusServer = startOrchestratorStatusServer({
      host: "127.0.0.1",
      port: 0,
      getProjectStatus: () => service.status(),
      onRefresh: async () => {
        await service.runOnce();
      },
    });
    await persistStatusServerPort(options.configDir, projectId, statusServer);

    logLine(
      green("\u25B2"),
      `Starting orchestrator for project: ${bold(projectId)}`
    );
    logLine(dim("\u00B7"), dim("Press Ctrl+C to stop"));

    let running = true;
    let shuttingDown = false;
    let shutdownPromise: Promise<never> | null = null;
    const shutdown = async () => {
      if (shuttingDown) {
        return shutdownPromise;
      }
      shuttingDown = true;
      running = false;
      const heldLock = projectLock;
      projectLock = null;
      shutdownPromise = shutdownForegroundOrchestrator({
        configDir: options.configDir,
        projectId,
        statusServer,
        projectLock: heldLock,
      });
      return shutdownPromise;
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });

    let prevSnapshot: ProjectStatusSnapshot | null = null;
    let isFirst = true;

    while (running) {
      try {
        const snapshot = await service.runOnce();
        logTickResult(snapshot, prevSnapshot, isFirst);

        if (!isFirst) {
          const currentRunIds = new Set(
            snapshot.activeRuns.map((run) => run.runId)
          );
          for (const prevRun of prevSnapshot?.activeRuns ?? []) {
            if (!currentRunIds.has(prevRun.runId)) {
              await tailWorkerLog(
                runtimeRoot,
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

      if (!running) {
        if (shutdownPromise) {
          await shutdownPromise;
        }
        break;
      }

      // Poll interval: default 30s
      await new Promise((r) => setTimeout(r, 30_000));
    }
  } finally {
    await releaseProjectLock(projectLock);
  }
};

export async function shutdownForegroundOrchestrator(
  input: ForegroundShutdownOptions
): Promise<never> {
  logLine(yellow("\u25BC"), "Shutting down...");

  try {
    input.statusServer.close();
  } catch (error) {
    logLine(
      red("\u2717"),
      red(
        `Failed to close status server: ${error instanceof Error ? error.message : "Unknown error"}`
      )
    );
  }

  try {
    await (input.removePortFile ?? rm)(
      orchestratorPortPath(input.configDir, input.projectId),
      {
        force: true,
      }
    );
  } catch (error) {
    logLine(
      yellow("\u26A0"),
      `Failed to remove persisted status port: ${error instanceof Error ? error.message : "Unknown error"}`
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
  runId: string,
  issueIdentifier: string
): Promise<void> {
  try {
    const logPath = join(
      runtimeRoot,
      "orchestrator",
      "runs",
      runId,
      "worker.log"
    );
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
  projectId: string
): Promise<void> {
  const logPath = orchestratorLogPath(options.configDir, projectId);
  await mkdir(dirname(logPath), { recursive: true });

  const { openSync } = await import("node:fs");
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [process.argv[1]!, "start", "--project", projectId],
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

async function persistStatusServerPort(
  configDir: string,
  projectId: string,
  statusServer: ReturnType<typeof startOrchestratorStatusServer>
): Promise<void> {
  if (!statusServer.listening) {
    await once(statusServer, "listening");
  }

  const address = statusServer.address();
  if (!address || typeof address !== "object") {
    return;
  }

  const portPath = orchestratorPortPath(configDir, projectId);
  await mkdir(dirname(portPath), { recursive: true });
  await writeFile(portPath, `${address.port}\n`, "utf8");
}

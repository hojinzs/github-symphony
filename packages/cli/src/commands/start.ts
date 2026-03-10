import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import type { GlobalOptions } from "../index.js";
import { daemonPidPath, orchestratorLogPath, logsDir } from "../config.js";
import {
  OrchestratorService,
  createStore,
  startOrchestratorStatusServer,
} from "@github-symphony/orchestrator";
import type { WorkspaceStatusSnapshot } from "@github-symphony/core";
import {
  resolveWorkspaceConfig,
  resolveRuntimeRoot,
  syncWorkspaceToRuntime,
} from "../orchestrator-runtime.js";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const _bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const _dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const _green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const _red = (s: string) => `${ESC}31m${s}${ESC}0m`;
const _yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const _cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;

let noColor = false;
const bold = (s: string) => (noColor ? s : _bold(s));
const dim = (s: string) => (noColor ? s : _dim(s));
const green = (s: string) => (noColor ? s : _green(s));
const red = (s: string) => (noColor ? s : _red(s));
const yellow = (s: string) => (noColor ? s : _yellow(s));
const cyan = (s: string) => (noColor ? s : _cyan(s));

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

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseStartArgs(args: string[]): {
  daemon: boolean;
  workspaceId?: string;
} {
  const parsed: { daemon: boolean; workspaceId?: string } = { daemon: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--daemon" || arg === "-d") {
      parsed.daemon = true;
    }
    if (arg === "--workspace" || arg === "--workspace-id") {
      parsed.workspaceId = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

// ── Tick logging ──────────────────────────────────────────────────────────────

function logTickResult(
  snapshots: WorkspaceStatusSnapshot[],
  prevSnapshots: WorkspaceStatusSnapshot[],
  isFirst: boolean
): void {
  for (const snap of snapshots) {
    const prev = prevSnapshots.find((p) => p.workspaceId === snap.workspaceId);

    if (isFirst) {
      const healthColor =
        snap.health === "degraded"
          ? red
          : snap.health === "running"
            ? green
            : cyan;
      logLine(
        green("\u25CF"),
        `Workspace ${bold(snap.slug)} connected ${dim("(")}${healthColor(snap.health)}${dim(")")}`
      );
      if (snap.summary.activeRuns > 0) {
        logLine(cyan("\u25B8"), `${snap.summary.activeRuns} active run(s)`);
      }
      continue;
    }

    // Health changes
    if (prev && prev.health !== snap.health) {
      const icon = snap.health === "degraded" ? red("\u25CF") : green("\u25CF");
      logLine(
        icon,
        `Health changed: ${prev.health} \u2192 ${bold(snap.health)}`
      );
    }

    // New error
    if (snap.lastError && snap.lastError !== prev?.lastError) {
      logLine(red("\u2717"), red(snap.lastError));
    }

    // Error cleared
    if (!snap.lastError && prev?.lastError) {
      logLine(green("\u2713"), green("Error cleared"));
    }

    // Dispatched delta
    const prevDispatched = prev?.summary.dispatched ?? 0;
    if (snap.summary.dispatched > prevDispatched) {
      const delta = snap.summary.dispatched - prevDispatched;
      logLine(yellow("\u25B8"), `Dispatched ${bold(String(delta))} new run(s)`);
    }

    // Active run changes
    const prevRunIds = new Set(prev?.activeRuns.map((r) => r.runId) ?? []);
    for (const run of snap.activeRuns) {
      if (!prevRunIds.has(run.runId)) {
        logLine(
          cyan("\u25B8"),
          `Run started: ${bold(run.issueIdentifier)} ${dim("phase=")}${run.phase} ${dim("status=")}${run.status}`
        );
      }
    }

    // Completed runs (were active, now gone)
    const currentRunIds = new Set(snap.activeRuns.map((r) => r.runId));
    for (const prevRun of prev?.activeRuns ?? []) {
      if (!currentRunIds.has(prevRun.runId)) {
        logLine(
          green("\u2713"),
          `Run finished: ${bold(prevRun.issueIdentifier)} ${dim("(")}${prevRun.status}${dim(")")}`
        );
      }
    }

    // Suppressed delta
    const prevSuppressed = prev?.summary.suppressed ?? 0;
    if (snap.summary.suppressed > prevSuppressed) {
      const delta = snap.summary.suppressed - prevSuppressed;
      logLine(
        dim("\u25CB"),
        dim(`${delta} issue(s) suppressed (already running or at limit)`)
      );
    }

    // Recovered delta
    const prevRecovered = prev?.summary.recovered ?? 0;
    if (snap.summary.recovered > prevRecovered) {
      const delta = snap.summary.recovered - prevRecovered;
      logLine(
        yellow("\u21BA"),
        `Recovered ${bold(String(delta))} stalled run(s)`
      );
    }

    // Retry queue changes
    const prevRetryCount = prev?.retryQueue.length ?? 0;
    if (snap.retryQueue.length > prevRetryCount) {
      const delta = snap.retryQueue.length - prevRetryCount;
      logLine(yellow("\u25CC"), `${delta} run(s) queued for retry`);
    }

    // Quiet tick — no changes
    const changed =
      snap.health !== prev?.health ||
      snap.lastError !== prev?.lastError ||
      snap.summary.dispatched !== prev?.summary.dispatched ||
      snap.summary.suppressed !== prev?.summary.suppressed ||
      snap.summary.recovered !== prev?.summary.recovered ||
      snap.activeRuns.length !== (prev?.activeRuns.length ?? 0) ||
      snap.retryQueue.length !== (prev?.retryQueue.length ?? 0);

    if (!changed) {
      logLine(
        dim("\u00B7"),
        dim(`tick \u2014 ${snap.summary.activeRuns} active, ${snap.health}`)
      );
    }
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  noColor = options.noColor;
  const parsed = parseStartArgs(args);

  const wsConfig = await resolveWorkspaceConfig(
    options.configDir,
    parsed.workspaceId
  );
  if (!wsConfig) {
    process.stderr.write(
      "No workspace configured. Run 'gh-symphony init' first.\n"
    );
    process.exitCode = 1;
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const workspaceId = wsConfig.workspaceId;
  await syncWorkspaceToRuntime(options.configDir, wsConfig);

  if (parsed.daemon) {
    await startDaemon(options, workspaceId);
    return;
  }

  // ── 5.1: Foreground mode with live logging ────────────────────────────────
  const store = createStore(runtimeRoot);
  const service = new OrchestratorService(store);

  // Start status server
  startOrchestratorStatusServer({
    host: "127.0.0.1",
    port: 4680,
    getWorkspaceStatus: {
      all: () => service.status(),
      byWorkspaceId: async (id) => {
        const [snapshot] = await service.status(id);
        return snapshot ?? null;
      },
    },
  });

  logLine(
    green("\u25B2"),
    `Starting orchestrator for workspace: ${bold(workspaceId)}`
  );
  logLine(dim("\u00B7"), dim("Press Ctrl+C to stop"));

  let running = true;
  const shutdown = () => {
    running = false;
    logLine(yellow("\u25BC"), "Shutting down...");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let prevSnapshots: WorkspaceStatusSnapshot[] = [];
  let isFirst = true;

  while (running) {
    try {
      const snapshots = await service.runOnce({ workspaceId });
      logTickResult(snapshots, prevSnapshots, isFirst);
      prevSnapshots = snapshots;
      isFirst = false;
    } catch (error) {
      logLine(
        red("\u2717"),
        red(
          `Tick error: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      );
    }

    // Poll interval: default 30s
    await new Promise((r) => setTimeout(r, 30_000));
  }
};

export default handler;

// ── 5.2: Daemon mode ─────────────────────────────────────────────────────────

async function startDaemon(
  options: GlobalOptions,
  workspaceId: string
): Promise<void> {
  const logPath = orchestratorLogPath(options.configDir);
  await mkdir(logsDir(options.configDir), { recursive: true });

  const { openSync } = await import("node:fs");
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [process.argv[1]!, "start", "--workspace", workspaceId],
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

  const pidPath = daemonPidPath(options.configDir);
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(child.pid), "utf8");

  child.unref();

  const { closeSync } = await import("node:fs");
  closeSync(logFd);

  process.stdout.write(
    `Orchestrator started in background (PID: ${child.pid}).\n` +
      `Logs: ${logPath}\n` +
      `Stop with: gh-symphony stop\n`
  );
}

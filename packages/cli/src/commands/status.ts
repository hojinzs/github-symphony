import type { GlobalOptions } from "../index.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  WorkflowConfigStore,
  type ProjectStatusSnapshot,
} from "@gh-symphony/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";
import { rejectRemovedProjectId } from "../removed-project-id.js";
import { writeCliError } from "../cli-error.js";
import { bold, dim, green, red, yellow, cyan, stripAnsi } from "../ansi.js";
import { clearScreen, showCursor, hideCursor } from "../ansi.js";
import { renderDashboard } from "../dashboard/renderer.js";
import { formatRepositoryDisplay } from "../format/repository.js";
import { resolveDaemonLiveness } from "../daemon-liveness.js";
import { resolveAdaptivePollIntervalMs } from "@gh-symphony/orchestrator";

const workflowConfigStore = new WorkflowConfigStore();

function healthIcon(
  health: "idle" | "running" | "degraded" | "stopped"
): string {
  switch (health) {
    case "idle":
    case "running":
      return green("●");
    case "degraded":
    case "stopped":
      return red("●");
  }
}

export function relativeTime(
  isoString: string,
  nowMs: number = Date.now()
): string {
  const now = new Date(nowMs);
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  const diffS = Math.floor(diffMs / 1000);
  const diffM = Math.floor(diffS / 60);
  const diffH = Math.floor(diffM / 60);
  const diffD = Math.floor(diffH / 24);

  if (diffS < 60) return `${diffS}s ago`;
  if (diffM < 60) return `${diffM}m ago`;
  if (diffH >= 48) return `${diffD}d ago`;
  return `${diffH}h ago`;
}

type RuntimeStatus = {
  daemonRunning: boolean;
  lastTickStale: boolean;
};

async function resolveStaleThresholdMs(
  workspaceDir: string,
  rateLimits: Record<string, unknown> | null | undefined
): Promise<number> {
  try {
    const resolution = await workflowConfigStore.load(
      join(workspaceDir, "WORKFLOW.md")
    );
    return (
      resolveAdaptivePollIntervalMs(
        resolution.workflow.polling.intervalMs,
        rateLimits ?? null
      ) * 3
    );
  } catch {
    return (
      resolveAdaptivePollIntervalMs(
        DEFAULT_POLL_INTERVAL_MS,
        rateLimits ?? null
      ) * 3
    );
  }
}

function isLastTickStale(
  lastTickAt: string,
  thresholdMs: number,
  nowMs: number = Date.now()
): boolean {
  const lastTickMs = new Date(lastTickAt).getTime();
  return Number.isFinite(lastTickMs) && nowMs - lastTickMs > thresholdMs;
}

async function resolveRuntimeStatus(options: {
  configDir: string;
  projectId: string;
  workspaceDir: string;
  snapshot: ProjectStatusSnapshot | null;
}): Promise<RuntimeStatus> {
  const liveness = await resolveDaemonLiveness(options);
  if (!liveness.running) {
    return { daemonRunning: false, lastTickStale: false };
  }
  if (!options.snapshot) {
    return { daemonRunning: true, lastTickStale: false };
  }
  const staleThresholdMs = await resolveStaleThresholdMs(
    options.workspaceDir,
    options.snapshot.rateLimits
  );
  return {
    daemonRunning: true,
    lastTickStale: isLastTickStale(
      options.snapshot.lastTickAt,
      staleThresholdMs
    ),
  };
}

function withDaemonRunning(
  snapshot: ProjectStatusSnapshot | null,
  daemonRunning: boolean
): (ProjectStatusSnapshot & { daemonRunning: boolean }) | null {
  return snapshot ? { ...snapshot, daemonRunning } : null;
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len - 3) + "...";
}

function formatTokenPair(delta: number, cumulative: number): string {
  return `${delta.toLocaleString("en-US")} / ${cumulative.toLocaleString("en-US")}`;
}

function resolveProjectTokenDelta(snapshot: ProjectStatusSnapshot): number {
  return snapshot.activeRuns.reduce(
    (sum, run) => sum + (run.tokenUsage?.totalTokens ?? 0),
    0
  );
}

function renderLegacyStatus(
  snapshot: ProjectStatusSnapshot,
  noColor: boolean,
  runtimeStatus: RuntimeStatus
): string {
  const apply = noColor ? (s: string) => stripAnsi(s) : (s: string) => s;

  const lines: string[] = [];

  // Header
  const headerTitle = `gh-symphony ∙ ${formatRepositoryDisplay(snapshot)}`;
  const headerWidth = 45;
  const headerPadding = Math.max(
    0,
    headerWidth - stripAnsi(headerTitle).length
  );
  lines.push("╭" + "─".repeat(headerWidth) + "╮");
  lines.push(
    "│  " + apply(bold(headerTitle)) + " ".repeat(headerPadding) + "│"
  );
  lines.push("╰" + "─".repeat(headerWidth) + "╯");
  lines.push("");

  // Health and last tick
  const renderedHealth = runtimeStatus.daemonRunning
    ? snapshot.health
    : "stopped";
  const healthStr = apply(
    `${healthIcon(renderedHealth)} Health    ${renderedHealth}`
  );
  const staleLabel = runtimeStatus.lastTickStale
    ? apply(yellow(" (stale)"))
    : "";
  const lastTickStr = apply(`Last tick  ${relativeTime(snapshot.lastTickAt)}`);
  lines.push(
    `  ${healthStr}${" ".repeat(Math.max(0, 30 - stripAnsi(healthStr).length))}${lastTickStr}${staleLabel}`
  );
  if (!runtimeStatus.daemonRunning) {
    lines.push(
      apply(yellow("  daemon not running — run 'gh-symphony repo start'"))
    );
    lines.push(apply(dim(`  Last known state: ${snapshot.health}`)));
  }
  lines.push("");

  // Summary stats
  const dispatchedStr = apply(`Dispatched   ${snapshot.summary.dispatched}`);
  const activeRunsStr = apply(`Active Runs  ${snapshot.summary.activeRuns}`);
  const suppressedStr = apply(`Suppressed   ${snapshot.summary.suppressed}`);
  const recoveredStr = apply(`Recovered    ${snapshot.summary.recovered}`);
  const skippedStr = apply(`Skipped      ${snapshot.summary.skipped ?? 0}`);

  lines.push(
    `  ${dispatchedStr}${" ".repeat(Math.max(0, 20 - stripAnsi(dispatchedStr).length))}${activeRunsStr}`
  );
  lines.push(
    `  ${suppressedStr}${" ".repeat(Math.max(0, 20 - stripAnsi(suppressedStr).length))}${recoveredStr}`
  );
  lines.push(`  ${skippedStr}`);
  lines.push("");

  // Active runs table
  if (snapshot.activeRuns.length > 0) {
    lines.push("  Active Runs:");
    for (const run of snapshot.activeRuns) {
      const runIdDisplay = truncate(run.runId, 12);
      const stateStr = apply(cyan(run.issueState));
      const statusColor =
        run.status === "running"
          ? green
          : run.status === "failed"
            ? red
            : run.status === "succeeded"
              ? green
              : dim;
      const statusStr = apply(statusColor(run.status));
      lines.push(
        `    ${runIdDisplay}  ${run.issueIdentifier}  ${stateStr}  ${statusStr}`
      );
    }
    lines.push("");
  } else {
    lines.push("  No active runs.");
    lines.push("");
  }

  // Retry queue
  if (snapshot.retryQueue.length > 0) {
    lines.push("  Retry Queue:");
    for (const retry of snapshot.retryQueue) {
      const runIdDisplay = truncate(retry.runId, 12);
      const nextRetryDisplay = retry.nextRetryAt
        ? relativeTime(retry.nextRetryAt)
        : "pending";
      lines.push(
        `    ${runIdDisplay}  ${retry.issueIdentifier}  ${apply(yellow(retry.retryKind))}  ${nextRetryDisplay}`
      );
    }
    lines.push("");
  }

  if (snapshot.recovery) {
    const recovery = snapshot.recovery;
    lines.push(apply(yellow("  Recoverable incomplete turn:")));
    lines.push(`    Run        ${recovery.runId}`);
    lines.push(`    Issue      ${recovery.issueId}`);
    lines.push(`    Workspace  ${recovery.workspacePath}`);
    lines.push(
      `    Dirty      ${recovery.dirtyFiles.length > 0 ? recovery.dirtyFiles.join(", ") : "none"}`
    );
    lines.push(`    Last       ${recovery.lastEvent ?? "unknown"}`);
    lines.push(`    At         ${recovery.lastEventAt ?? "unknown"}`);
    lines.push(`    Session    ${recovery.sessionId ?? "unknown"}`);
    lines.push(`    Thread     ${recovery.threadId ?? "unknown"}`);
    lines.push(`    Command    ${recovery.suggestedCommand}`);
    lines.push("");
  }

  // Last error
  if (snapshot.lastError) {
    lines.push(apply(red(`  ✗ ${snapshot.lastError}`)));
    lines.push("");
  }

  // Token usage
  if (snapshot.codexTotals) {
    const tokenDelta = resolveProjectTokenDelta(snapshot);
    const tokenStr = apply(
      `Tokens: ${formatTokenPair(tokenDelta, snapshot.codexTotals.totalTokens)} total`
    );
    lines.push(`  ${tokenStr}`);
  } else {
    lines.push("  Tokens: 0 / 0 total");
  }

  return lines.join("\n");
}

function parseStatusArgs(args: string[]): {
  watch: boolean;
  error?: string;
} {
  const parsed: { watch: boolean; error?: string } = {
    watch: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
      continue;
    }
    if (arg?.startsWith("-")) {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }
  }

  return parsed;
}

async function readStatusSnapshot(
  runtimeRoot: string,
  projectId: string
): Promise<ProjectStatusSnapshot | null> {
  for (const statusPath of [
    join(runtimeRoot, "status.json"),
    join(runtimeRoot, "projects", projectId, "status.json"),
  ]) {
    try {
      const content = await readFile(statusPath, "utf-8");
      return JSON.parse(content) as ProjectStatusSnapshot;
    } catch {
      // Try the next known runtime layout.
    }
  }
  return null;
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  if (rejectRemovedProjectId(args)) {
    return;
  }
  const parsed = parseStatusArgs(args);
  if (parsed.error) {
    writeCliError({
      code: "invalid_arguments",
      message: parsed.error,
      usage: "Usage: gh-symphony repo status [--watch]",
      json: options.json,
      exitCode: 2,
    });
    return;
  }

  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: undefined,
    json: options.json,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig({ json: options.json });
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const projectId = projectConfig.projectId;
  if (parsed.watch) {
    const isTTY = process.stdout.isTTY === true;
    let terminalWidth = process.stdout.columns ?? 115;
    let runPromise: Promise<void> | null = null;

    const run = async () => {
      const snapshot = await readStatusSnapshot(runtimeRoot, projectId);
      const runtimeStatus = await resolveRuntimeStatus({
        configDir: options.configDir,
        projectId,
        workspaceDir: projectConfig.workspaceDir,
        snapshot,
      });
      if (options.json || !isTTY) {
        process.stdout.write(
          JSON.stringify(
            snapshot
              ? withDaemonRunning(snapshot, runtimeStatus.daemonRunning)
              : { daemonRunning: runtimeStatus.daemonRunning },
            null,
            2
          ) + "\n"
        );
      } else {
        if (!snapshot) {
          process.stdout.write(
            clearScreen() + "Unable to read status snapshot.\n"
          );
          return;
        }
        process.stdout.write(
          clearScreen() +
            renderDashboard([snapshot], {
              terminalWidth,
              noColor: options.noColor,
              runtimeStatus: {
                ...runtimeStatus,
                lastTickLabel: relativeTime(snapshot.lastTickAt),
              },
            }) +
            "\n"
        );
      }
    };
    const tick = () => {
      if (runPromise) {
        return;
      }
      runPromise = run().finally(() => {
        runPromise = null;
      });
    };

    if (isTTY) {
      process.stdout.write(hideCursor());
    }

    tick();
    await runPromise;
    const interval = setInterval(tick, 2000);

    process.on("SIGWINCH", () => {
      terminalWidth = process.stdout.columns ?? terminalWidth;
    });

    const shutdown = () => {
      clearInterval(interval);
      process.stdout.write(showCursor() + "\n");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise(() => {});
  }

  // Single status query
  const snapshot = await readStatusSnapshot(runtimeRoot, projectId);
  if (snapshot) {
    const runtimeStatus = await resolveRuntimeStatus({
      configDir: options.configDir,
      projectId,
      workspaceDir: projectConfig.workspaceDir,
      snapshot,
    });
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          withDaemonRunning(snapshot, runtimeStatus.daemonRunning),
          null,
          2
        ) + "\n"
      );
    } else {
      process.stdout.write(
        renderLegacyStatus(snapshot, options.noColor, runtimeStatus) + "\n"
      );
    }
  } else {
    const runtimeStatus = await resolveRuntimeStatus({
      configDir: options.configDir,
      projectId,
      workspaceDir: projectConfig.workspaceDir,
      snapshot: null,
    });
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            daemonRunning: runtimeStatus.daemonRunning,
            error: {
              code: "status_snapshot_unavailable",
              message: "Unable to read status snapshot.",
            },
          },
          null,
          2
        ) + "\n"
      );
      process.exitCode = 1;
    } else {
      writeCliError({
        code: "status_snapshot_unavailable",
        message: "Unable to read status snapshot.",
      });
    }
  }
};

export default handler;

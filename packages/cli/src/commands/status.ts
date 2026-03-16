import type { GlobalOptions } from "../index.js";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveRuntimeRoot,
  syncProjectToRuntime,
} from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";
import { bold, dim, green, red, yellow, cyan, stripAnsi } from "../ansi.js";
import { clearScreen, showCursor, hideCursor } from "../ansi.js";
import { renderDashboard } from "../dashboard/renderer.js";
import { resolveProjectOrchestratorStatusBaseUrl } from "../orchestrator-status-endpoint.js";
import { requestOrchestratorRefresh } from "./status-refresh.js";

const WATCH_REFRESH_TIMEOUT_MS = 1_500;

function healthIcon(health: "idle" | "running" | "degraded"): string {
  switch (health) {
    case "idle":
    case "running":
      return green("●");
    case "degraded":
      return red("●");
  }
}

function relativeTime(isoString: string): string {
  const now = new Date();
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  const diffS = Math.floor(diffMs / 1000);
  const diffM = Math.floor(diffS / 60);
  const diffH = Math.floor(diffM / 60);

  if (diffS < 60) return `${diffS}s ago`;
  if (diffM < 60) return `${diffM}m ago`;
  return `${diffH}h ago`;
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len - 3) + "...";
}

function renderLegacyStatus(
  snapshot: ProjectStatusSnapshot,
  noColor: boolean
): string {
  const apply = noColor ? (s: string) => stripAnsi(s) : (s: string) => s;

  const lines: string[] = [];

  // Header
  const headerTitle = `gh-symphony ∙ ${snapshot.slug}`;
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
  const healthStr = apply(
    `${healthIcon(snapshot.health)} Health    ${snapshot.health}`
  );
  const lastTickStr = apply(`Last tick  ${relativeTime(snapshot.lastTickAt)}`);
  lines.push(
    `  ${healthStr}${" ".repeat(Math.max(0, 30 - stripAnsi(healthStr).length))}${lastTickStr}`
  );
  lines.push("");

  // Summary stats
  const dispatchedStr = apply(`Dispatched   ${snapshot.summary.dispatched}`);
  const activeRunsStr = apply(`Active Runs  ${snapshot.summary.activeRuns}`);
  const suppressedStr = apply(`Suppressed   ${snapshot.summary.suppressed}`);
  const recoveredStr = apply(`Recovered    ${snapshot.summary.recovered}`);

  lines.push(
    `  ${dispatchedStr}${" ".repeat(Math.max(0, 20 - stripAnsi(dispatchedStr).length))}${activeRunsStr}`
  );
  lines.push(
    `  ${suppressedStr}${" ".repeat(Math.max(0, 20 - stripAnsi(suppressedStr).length))}${recoveredStr}`
  );
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

  // Last error
  if (snapshot.lastError) {
    lines.push(apply(red(`  ✗ ${snapshot.lastError}`)));
    lines.push("");
  }

  // Token usage
  if (snapshot.codexTotals) {
    const tokenStr = apply(
      `Tokens: ${snapshot.codexTotals.inputTokens} in / ${snapshot.codexTotals.outputTokens} out / ${snapshot.codexTotals.totalTokens} total`
    );
    lines.push(`  ${tokenStr}`);
  } else {
    lines.push("  Tokens: 0 in / 0 out / 0 total");
  }

  return lines.join("\n");
}

function parseStatusArgs(args: string[]): {
  watch: boolean;
  projectId?: string;
  error?: string;
} {
  const parsed: { watch: boolean; projectId?: string; error?: string } = {
    watch: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
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

async function readStatusSnapshot(
  runtimeRoot: string,
  projectId: string
): Promise<ProjectStatusSnapshot | null> {
  try {
    const statusPath = join(
      runtimeRoot,
      "orchestrator",
      "projects",
      projectId,
      "status.json"
    );
    const content = await readFile(statusPath, "utf-8");
    return JSON.parse(content) as ProjectStatusSnapshot;
  } catch {
    return null;
  }
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseStatusArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony status [--project-id <project-id>] [--watch]\n"
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

  if (parsed.watch) {
    const isTTY = process.stdout.isTTY === true;
    let terminalWidth = process.stdout.columns ?? 115;
    let runPromise: Promise<void> | null = null;

    const run = async () => {
      const baseUrl = await resolveProjectOrchestratorStatusBaseUrl({
        configDir: options.configDir,
        projectId,
      });
      await requestOrchestratorRefresh({
        baseUrl,
        timeoutMs: WATCH_REFRESH_TIMEOUT_MS,
      });
      const snapshot = await readStatusSnapshot(runtimeRoot, projectId);
      if (options.json || !isTTY) {
        process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
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
    if (options.json) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    } else {
      process.stdout.write(
        renderLegacyStatus(snapshot, options.noColor) + "\n"
      );
    }
  } else {
    process.stderr.write("Unable to read status snapshot.\n");
    process.exitCode = 1;
  }
};

export default handler;

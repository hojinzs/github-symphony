import type { GlobalOptions } from "../index.js";
import type { WorkspaceStatusSnapshot } from "@github-symphony/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveRuntimeRoot,
  resolveWorkspaceConfig,
  syncWorkspaceToRuntime,
} from "../orchestrator-runtime.js";

// ANSI color helpers
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}

function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}

function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}

function white(s: string): string {
  return `\x1b[37m${s}\x1b[0m`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

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

function renderDashboard(
  snapshot: WorkspaceStatusSnapshot,
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
      const phaseColor =
        run.phase === "planning"
          ? cyan
          : run.phase === "human-review"
            ? yellow
            : run.phase === "implementation"
              ? cyan
              : run.phase === "awaiting-merge"
                ? yellow
                : white;
      const phaseStr = apply(phaseColor(run.phase));
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
        `    ${runIdDisplay}  ${run.issueIdentifier}  ${phaseStr}  ${statusStr}`
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
  workspaceId?: string;
} {
  const parsed: { watch: boolean; workspaceId?: string } = { watch: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
    }
    if (arg === "--workspace" || arg === "--workspace-id") {
      parsed.workspaceId = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

async function readStatusSnapshot(
  runtimeRoot: string,
  workspaceId: string
): Promise<WorkspaceStatusSnapshot | null> {
  try {
    const statusPath = join(
      runtimeRoot,
      "orchestrator",
      "workspaces",
      workspaceId,
      "status.json"
    );
    const content = await readFile(statusPath, "utf-8");
    return JSON.parse(content) as WorkspaceStatusSnapshot;
  } catch {
    return null;
  }
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseStatusArgs(args);

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

  if (parsed.watch) {
    // Watch mode: poll every 2 seconds
    const clear = () => process.stdout.write("\x1b[2J\x1b[H");
    const run = async () => {
      clear();
      const snapshot = await readStatusSnapshot(runtimeRoot, workspaceId);
      if (snapshot) {
        if (options.json) {
          process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
        } else {
          process.stdout.write(
            renderDashboard(snapshot, options.noColor) + "\n"
          );
        }
      } else {
        process.stdout.write("Unable to read status snapshot.\n");
      }
    };
    await run();
    const interval = setInterval(() => void run(), 2000);

    const shutdown = () => {
      clearInterval(interval);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep alive
    await new Promise(() => {});
  }

  // Single status query
  const snapshot = await readStatusSnapshot(runtimeRoot, workspaceId);
  if (snapshot) {
    if (options.json) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    } else {
      process.stdout.write(renderDashboard(snapshot, options.noColor) + "\n");
    }
  } else {
    process.stderr.write("Unable to read status snapshot.\n");
    process.exitCode = 1;
  }
};

export default handler;

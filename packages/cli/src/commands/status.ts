import type { GlobalOptions } from "../index.js";
import type { TenantStatusSnapshot } from "@gh-symphony/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveRuntimeRoot,
  resolveTenantConfig,
  syncTenantToRuntime,
} from "../orchestrator-runtime.js";
import { bold, dim, green, red, yellow, cyan, stripAnsi } from "../ansi.js";
import { clearScreen, showCursor, hideCursor } from "../ansi.js";
import { renderDashboard } from "../dashboard/renderer.js";
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
  snapshot: TenantStatusSnapshot,
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
  tenantId?: string;
} {
  const parsed: { watch: boolean; tenantId?: string } = { watch: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
    }
    if (arg === "--tenant" || arg === "--tenant-id") {
      parsed.tenantId = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

async function readStatusSnapshot(
  runtimeRoot: string,
  tenantId: string
): Promise<TenantStatusSnapshot | null> {
  try {
    const statusPath = join(
      runtimeRoot,
      "orchestrator",
      "tenants",
      tenantId,
      "status.json"
    );
    const content = await readFile(statusPath, "utf-8");
    return JSON.parse(content) as TenantStatusSnapshot;
  } catch {
    return null;
  }
}

async function readAllStatusSnapshots(
  runtimeRoot: string
): Promise<TenantStatusSnapshot[]> {
  try {
    const tenantsDir = join(runtimeRoot, "orchestrator", "tenants");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tenantsDir, { withFileTypes: true });
    const snapshots: TenantStatusSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statusPath = join(tenantsDir, entry.name, "status.json");
      try {
        const content = await readFile(statusPath, "utf-8");
        snapshots.push(JSON.parse(content) as TenantStatusSnapshot);
      } catch {
        // skip missing/invalid files
      }
    }
    return snapshots;
  } catch {
    return [];
  }
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseStatusArgs(args);

  const tenantConfig = await resolveTenantConfig(
    options.configDir,
    parsed.tenantId
  );
  if (!tenantConfig) {
    process.stderr.write(
      "No tenant configured. Run 'gh-symphony init' first.\n"
    );
    process.exitCode = 1;
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const tenantId = tenantConfig.tenantId;
  await syncTenantToRuntime(options.configDir, tenantConfig);

  if (parsed.watch) {
    const isTTY = process.stdout.isTTY === true;
    let terminalWidth = process.stdout.columns ?? 115;
    let runPromise: Promise<void> | null = null;

    const run = async () => {
      await requestOrchestratorRefresh({
        timeoutMs: WATCH_REFRESH_TIMEOUT_MS,
      });
      const snapshots = await readAllStatusSnapshots(runtimeRoot);
      if (options.json || !isTTY) {
        process.stdout.write(JSON.stringify(snapshots, null, 2) + "\n");
      } else {
        process.stdout.write(
          clearScreen() +
            renderDashboard(snapshots, {
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
  const snapshot = await readStatusSnapshot(runtimeRoot, tenantId);
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

import {
  inspectGlobalRepositoryCache,
  pruneGlobalRepositoryCache,
} from "@gh-symphony/orchestrator";
import type { GlobalOptions } from "../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand] = args;
  if (subcommand === "status") {
    const entries = await inspectGlobalRepositoryCache({
      configDir: options.configDir,
    });
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            entries,
            totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          },
          null,
          2
        ) + "\n"
      );
      return;
    }
    if (entries.length === 0) {
      process.stdout.write("Global repository cache is empty.\n");
      return;
    }
    for (const entry of entries) {
      const state = entry.locked
        ? "locked"
        : entry.worktrees
          ? `${entry.worktrees} linked worktree(s)`
          : "idle";
      process.stdout.write(
        `${entry.repository}  ${formatBytes(entry.bytes)}  ${state}  ${entry.updatedAt}\n`
      );
    }
    return;
  }
  if (subcommand === "prune") {
    const rawDays = valueAfter(args, "--max-age-days") ?? "30";
    const days = Number(rawDays);
    if (!Number.isFinite(days) || days < 0)
      throw new Error("--max-age-days must be a non-negative number.");
    const result = await pruneGlobalRepositoryCache({
      configDir: options.configDir,
      maxAgeMs: days * DAY_MS,
      dryRun: args.includes("--dry-run"),
    });
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `${result.dryRun ? "Would remove" : "Removed"} ${result.removed.length} cache entr${result.removed.length === 1 ? "y" : "ies"} (${formatBytes(result.reclaimedBytes)}); skipped ${result.skipped.length}.\n`
    );
    return;
  }
  throw new Error("Usage: gh-symphony cache <status|prune>");
};

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default handler;

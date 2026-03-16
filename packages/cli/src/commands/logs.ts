import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { GlobalOptions } from "../index.js";
import { orchestratorLogPath } from "../config.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";

function parseLogsArgs(args: string[]): {
  follow: boolean;
  issue?: string;
  run?: string;
  level?: string;
  projectId?: string;
} {
  const parsed: {
    follow: boolean;
    issue?: string;
    run?: string;
    level?: string;
    projectId?: string;
  } = { follow: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--follow" || arg === "-f") {
      parsed.follow = true;
    }
    if (arg === "--issue") {
      parsed.issue = args[i + 1];
      i += 1;
    }
    if (arg === "--run") {
      parsed.run = args[i + 1];
      i += 1;
    }
    if (arg === "--level") {
      parsed.level = args[i + 1];
      i += 1;
    }
    if (arg === "--project" || arg === "--project-id") {
      parsed.projectId = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseLogsArgs(args);

  // If --run is specified, read that run's events
  if (parsed.run) {
    const eventsPath = join(
      resolve(options.configDir),
      "orchestrator",
      "runs",
      parsed.run,
      "events.ndjson"
    );
    try {
      const content = await readFile(eventsPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (parsed.projectId && event.projectId !== parsed.projectId) continue;
        if (parsed.level && event.level !== parsed.level) continue;
        if (parsed.issue && event.issueIdentifier !== parsed.issue) continue;
        process.stdout.write(formatEvent(event) + "\n");
      }
    } catch {
      process.stderr.write(`No events found for run: ${parsed.run}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // Default: read orchestrator log or scan all events
  if (parsed.follow) {
    const projectConfig = await resolveManagedProjectConfig({
      configDir: options.configDir,
      requestedProjectId: parsed.projectId,
    });
    if (!projectConfig) {
      handleMissingManagedProjectConfig();
      return;
    }

    const logPath = orchestratorLogPath(
      options.configDir,
      projectConfig.projectId
    );
    try {
      const stream = createReadStream(logPath, { encoding: "utf8" });
      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        process.stdout.write(line + "\n");
      }

      // Follow mode: watch for new lines
      const { watchFile } = await import("node:fs");
      let lastSize = 0;
      watchFile(logPath, { interval: 1000 }, async (curr) => {
        if (curr.size > lastSize) {
          const fd = await import("node:fs/promises");
          const handle = await fd.open(logPath, "r");
          const buf = Buffer.alloc(curr.size - lastSize);
          await handle.read(buf, 0, buf.length, lastSize);
          await handle.close();
          process.stdout.write(buf.toString("utf8"));
          lastSize = curr.size;
        }
      });

      // Keep alive
      await new Promise(() => {});
    } catch {
      process.stderr.write(
        "No log file found. Start the orchestrator first.\n"
      );
      process.exitCode = 1;
    }
    return;
  }

  // Scan all run events
  const runsDir = join(resolve(options.configDir), "orchestrator", "runs");
  try {
    const entries = await readdir(runsDir);
    for (const entry of entries) {
      const eventsPath = join(runsDir, entry, "events.ndjson");
      try {
        const content = await readFile(eventsPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (parsed.projectId && event.projectId !== parsed.projectId)
            continue;
          if (parsed.level && event.level !== parsed.level) continue;
          if (parsed.issue && event.issueIdentifier !== parsed.issue) continue;
          process.stdout.write(formatEvent(event) + "\n");
        }
      } catch {
        // Skip runs without events
      }
    }
  } catch {
    process.stderr.write("No runs found. Start the orchestrator first.\n");
  }
};

export default handler;

function formatEvent(event: Record<string, unknown>): string {
  const at = event.at ?? "";
  const eventType = event.event ?? "unknown";
  const issue = event.issueIdentifier ?? "";
  const extra = event.error ? ` error=${event.error}` : "";
  return `[${at}] ${eventType} ${issue}${extra}`;
}

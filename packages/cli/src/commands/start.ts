import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import type { GlobalOptions } from "../index.js";
import {
  daemonPidPath,
  orchestratorLogPath,
  logsDir,
} from "../config.js";
import { runCli as orchestratorRunCli } from "@github-symphony/orchestrator";
import {
  resolveWorkspaceConfig,
  resolveRuntimeRoot,
  syncWorkspaceToRuntime,
} from "../orchestrator-runtime.js";

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

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
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

  // The orchestrator runtime root: CLI config dir serves as runtime root
  // Orchestrator expects <runtimeRoot>/orchestrator/workspaces/<id>/config.json
  const runtimeRoot = resolveRuntimeRoot(options.configDir);

  await syncWorkspaceToRuntime(options.configDir, wsConfig);

  if (parsed.daemon) {
    await startDaemon(options, wsConfig.workspaceId);
    return;
  }

  // ── 5.1: Foreground mode ─────────────────────────────────────────────────
  process.stdout.write(
    `Starting orchestrator for workspace: ${wsConfig.workspaceId}\n`
  );

  const workspaceId = wsConfig.workspaceId;

  // Graceful shutdown
  const shutdown = () => {
    process.stdout.write("\nShutting down...\n");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Delegate to the orchestrator's own runCli
  await orchestratorRunCli([
    "run",
    "--runtime-root",
    runtimeRoot,
    "--workspace-id",
    workspaceId,
  ]);
};

export default handler;

// ── 5.2: Daemon mode ─────────────────────────────────────────────────────────

async function startDaemon(
  options: GlobalOptions,
  workspaceId: string
): Promise<void> {
  const logPath = orchestratorLogPath(options.configDir);
  await mkdir(logsDir(options.configDir), { recursive: true });

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
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const { createWriteStream } = await import("node:fs");
  const logStream = createWriteStream(logPath, { flags: "a" });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  const pidPath = daemonPidPath(options.configDir);
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(child.pid), "utf8");

  child.unref();

  process.stdout.write(
    `Orchestrator started in background (PID: ${child.pid}).\n` +
      `Logs: ${logPath}\n` +
      `Stop with: gh-symphony stop\n`
  );
}

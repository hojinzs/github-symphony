import { readFile, rm } from "node:fs/promises";
import type { GlobalOptions } from "../index.js";
import { daemonPidPath, orchestratorPortPath } from "../config.js";

function parseStopArgs(args: string[]): { force: boolean; projectId?: string } {
  const parsed: { force: boolean; projectId?: string } = {
    force: args.includes("--force"),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
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
  const { force, projectId } = parseStopArgs(args);
  if (!projectId) {
    process.stderr.write(
      "Usage: gh-symphony stop --project-id <project-id> [--force]\n"
    );
    process.exitCode = 2;
    return;
  }

  const pidPath = daemonPidPath(options.configDir, projectId);
  const portPath = orchestratorPortPath(options.configDir, projectId);

  let pidStr: string;
  try {
    pidStr = await readFile(pidPath, "utf8");
  } catch {
    process.stderr.write(
      `No running daemon found for project "${projectId}" (PID file missing).\n`
    );
    process.exitCode = 1;
    return;
  }

  const pid = Number.parseInt(pidStr.trim(), 10);
  if (!Number.isFinite(pid)) {
    process.stderr.write(`Invalid PID in ${pidPath}: ${pidStr}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    // Check if process is running
    process.kill(pid, 0);
  } catch {
    process.stdout.write(
      `Daemon for project "${projectId}" (PID ${pid}) is not running. Cleaning up PID file.\n`
    );
    await rm(pidPath, { force: true });
    await rm(portPath, { force: true });
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pid, signal);
    process.stdout.write(`Sent ${signal} to orchestrator (PID ${pid}).\n`);
  } catch (error) {
    process.stderr.write(
      `Failed to stop process ${pid}: ${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
    return;
  }

  await rm(pidPath, { force: true });
  if (force) {
    await rm(portPath, { force: true });
  }
  process.stdout.write("Daemon stopped.\n");
};

export default handler;

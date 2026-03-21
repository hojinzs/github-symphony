import { readFile, rm } from "node:fs/promises";
import type { GlobalOptions } from "../index.js";
import { daemonPidPath } from "../config.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";

function parseStopArgs(args: string[]): {
  force: boolean;
  projectId?: string;
  error?: string;
} {
  const parsed: { force: boolean; projectId?: string; error?: string } = {
    force: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--force") {
      parsed.force = true;
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

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseStopArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony stop --project-id <project-id> [--force]\n"
    );
    process.exitCode = 2;
    return;
  }
  const resolvedForce = parsed.force;
  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: parsed.projectId,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig();
    return;
  }
  const resolvedProjectId = projectConfig.projectId;

  const pidPath = daemonPidPath(options.configDir, resolvedProjectId);
  let pidStr: string;
  try {
    pidStr = await readFile(pidPath, "utf8");
  } catch {
    process.stderr.write(
      `No running daemon found for project "${resolvedProjectId}" (PID file missing).\n`
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
      `Daemon for project "${resolvedProjectId}" (PID ${pid}) is not running. Cleaning up PID file.\n`
    );
    await rm(pidPath, { force: true });
    return;
  }

  const signal = resolvedForce ? "SIGKILL" : "SIGTERM";
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
  process.stdout.write("Daemon stopped.\n");
};

export default handler;

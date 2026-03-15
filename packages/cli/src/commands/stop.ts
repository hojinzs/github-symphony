import { readFile, rm } from "node:fs/promises";
import type { GlobalOptions } from "../index.js";
import { daemonPidPath, orchestratorPortPath } from "../config.js";
import { parseCliArgs } from "./parse-cli-args.js";

function parseStopArgs(args: string[]): {
  force: boolean;
  projectId?: string;
  error?: string;
} {
  const parsed = parseCliArgs(args, {
    force: { type: "boolean" },
    project: { type: "string" },
    "project-id": { type: "string" },
  });
  if ("error" in parsed) {
    return { force: false, error: parsed.error };
  }

  return {
    force: Boolean(parsed.values.force),
    projectId: (parsed.values["project-id"] ?? parsed.values.project) as
      | string
      | undefined,
  };
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
  if (!parsed.projectId) {
    process.stderr.write(
      "Usage: gh-symphony stop --project-id <project-id> [--force]\n"
    );
    process.exitCode = 2;
    return;
  }
  const resolvedForce = parsed.force;
  const resolvedProjectId = parsed.projectId;

  const pidPath = daemonPidPath(options.configDir, resolvedProjectId);
  const portPath = orchestratorPortPath(options.configDir, resolvedProjectId);

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
    await rm(portPath, { force: true });
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
  if (resolvedForce) {
    await rm(portPath, { force: true });
  }
  process.stdout.write("Daemon stopped.\n");
};

export default handler;

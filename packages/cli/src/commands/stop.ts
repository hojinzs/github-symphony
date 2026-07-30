import { readFile, rm } from "node:fs/promises";
import { getProcessIdentity } from "@gh-symphony/orchestrator";
import type { GlobalOptions } from "../index.js";
import { daemonPidPath, parseDaemonPidRecord } from "../config.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";
import { rejectRemovedProjectId } from "../removed-project-id.js";

function parseStopArgs(args: string[]): {
  force: boolean;
  error?: string;
} {
  const parsed: { force: boolean; error?: string } = {
    force: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--force") {
      parsed.force = true;
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
  if (rejectRemovedProjectId(args)) {
    return;
  }
  const parsed = parseStopArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write("Usage: gh-symphony repo stop [--force]\n");
    process.exitCode = 2;
    return;
  }
  const resolvedForce = parsed.force;
  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: undefined,
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

  const pidRecord = parseDaemonPidRecord(pidStr);
  if (!pidRecord) {
    process.stderr.write(`Invalid PID in ${pidPath}: ${pidStr}\n`);
    process.exitCode = 1;
    return;
  }
  const pid = pidRecord.pid;

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

  const checkedIdentity = getProcessIdentity(pid);
  const identityMatches = pidRecord.processIdentity
    ? checkedIdentity === pidRecord.processIdentity
    : isLegacyOrchestratorIdentity(checkedIdentity);
  if (!identityMatches) {
    process.stderr.write(
      `Refusing to stop PID ${pid}: process identity does not match the recorded orchestrator daemon. Cleaning up stale PID file.\n`
    );
    await rm(pidPath, { force: true });
    process.exitCode = 1;
    return;
  }

  const signal = resolvedForce ? "SIGKILL" : "SIGTERM";
  try {
    if (getProcessIdentity(pid) !== checkedIdentity) {
      throw new Error("process identity changed before signal delivery");
    }
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

function isLegacyOrchestratorIdentity(identity: string | null): boolean {
  return Boolean(
    identity &&
    /(?:gh-symphony|(?:^|\s)(?:dist\/)?index\.js)(?:\s|$)/.test(identity) &&
    /\brepo\s+start\b/.test(identity)
  );
}

export default handler;

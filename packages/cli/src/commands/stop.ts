import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getProcessCwd, getProcessIdentity } from "@gh-symphony/orchestrator";
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
  const expectedCwd = resolve(pidRecord.cwd ?? process.cwd());
  let target = validateDaemonProcess(
    pidRecord.pid,
    pidRecord.processIdentity,
    expectedCwd
  );
  if (!target) {
    target = await resolveProjectLockDaemon(
      options.configDir,
      resolvedProjectId,
      expectedCwd
    );
    if (!target) {
      process.stderr.write(
        `Stale daemon PID ${pidRecord.pid} for project "${resolvedProjectId}"; no live orchestrator with repository CWD "${expectedCwd}" was found in the project lock. Cleaning up stale PID file.\n`
      );
      await rm(pidPath, { force: true });
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Recovered orchestrator PID ${target.pid} from the project lock for repository CWD "${expectedCwd}".\n`
    );
  }

  const { pid, identity: checkedIdentity } = target;

  const signal = resolvedForce ? "SIGKILL" : "SIGTERM";
  try {
    const signalCwd = getProcessCwd(pid);
    if (
      getProcessIdentity(pid) !== checkedIdentity ||
      !signalCwd ||
      resolve(signalCwd) !== expectedCwd
    ) {
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

function validateDaemonProcess(
  pid: number,
  recordedIdentity: string | null,
  expectedCwd: string
): { pid: number; identity: string } | null {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }

  const identity = getProcessIdentity(pid);
  const identityMatches = recordedIdentity
    ? identity === recordedIdentity
    : isLegacyOrchestratorIdentity(identity);
  const cwd = getProcessCwd(pid);
  if (!identity || !identityMatches || !cwd || resolve(cwd) !== expectedCwd) {
    return null;
  }
  return { pid, identity };
}

async function resolveProjectLockDaemon(
  configDir: string,
  projectId: string,
  expectedCwd: string
): Promise<{ pid: number; identity: string } | null> {
  try {
    const lock = JSON.parse(
      await readFile(join(configDir, "projects", projectId, ".lock"), "utf8")
    ) as { pid?: unknown; processIdentity?: unknown };
    if (!Number.isInteger(lock.pid) || (lock.pid as number) <= 0) {
      return null;
    }
    const processIdentity =
      typeof lock.processIdentity === "string" ? lock.processIdentity : null;
    return validateDaemonProcess(
      lock.pid as number,
      processIdentity,
      expectedCwd
    );
  } catch {
    return null;
  }
}

function isLegacyOrchestratorIdentity(identity: string | null): boolean {
  return Boolean(
    identity &&
    /(?:gh-symphony|(?:^|\s)(?:dist\/)?index\.js)(?:\s|$)/.test(identity) &&
    /\brepo\s+start\b/.test(identity)
  );
}

export default handler;

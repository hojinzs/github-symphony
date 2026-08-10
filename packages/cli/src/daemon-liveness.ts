import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getProcessCwd, getProcessIdentity } from "@gh-symphony/orchestrator";
import { daemonPidPath, parseDaemonPidRecord } from "./config.js";

export type DaemonProcessTarget = {
  pid: number;
  identity: string;
};

export type DaemonLiveness =
  | {
      running: true;
      target: DaemonProcessTarget;
      source: "pid" | "project-lock";
      expectedCwd: string;
      pidPath: string;
      recordedPid: number;
    }
  | {
      running: false;
      reason: "missing-pid" | "invalid-pid" | "stale-pid";
      pidPath: string;
      pidContents?: string;
      recordedPid?: number;
      expectedCwd?: string;
    };

export async function resolveDaemonLiveness(options: {
  configDir: string;
  projectId: string;
  workspaceDir: string;
}): Promise<DaemonLiveness> {
  const pidPath = daemonPidPath(options.configDir, options.projectId);
  let pidContents: string;
  try {
    pidContents = await readFile(pidPath, "utf8");
  } catch {
    return { running: false, reason: "missing-pid", pidPath };
  }

  const pidRecord = parseDaemonPidRecord(pidContents);
  if (!pidRecord) {
    return {
      running: false,
      reason: "invalid-pid",
      pidPath,
      pidContents,
    };
  }

  const expectedCwd = resolve(pidRecord.cwd ?? options.workspaceDir);
  const target = validateDaemonProcess(
    pidRecord.pid,
    pidRecord.processIdentity,
    expectedCwd
  );
  if (target) {
    return {
      running: true,
      target,
      source: "pid",
      expectedCwd,
      pidPath,
      recordedPid: pidRecord.pid,
    };
  }

  const lockTarget = await resolveProjectLockDaemon(
    options.configDir,
    options.projectId,
    expectedCwd
  );
  if (lockTarget) {
    return {
      running: true,
      target: lockTarget,
      source: "project-lock",
      expectedCwd,
      pidPath,
      recordedPid: pidRecord.pid,
    };
  }

  return {
    running: false,
    reason: "stale-pid",
    pidPath,
    recordedPid: pidRecord.pid,
    expectedCwd,
  };
}

export function validateDaemonProcess(
  pid: number,
  recordedIdentity: string | null,
  expectedCwd: string
): DaemonProcessTarget | null {
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
): Promise<DaemonProcessTarget | null> {
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

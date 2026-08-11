import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getProcessCwd, getProcessIdentity } from "@gh-symphony/orchestrator";
import { daemonPidPath, parseDaemonPidRecord } from "./config.js";

const PROJECT_LOCK_HEARTBEAT_MAX_AGE_MS = 60_000;

export type DaemonProcessTarget = {
  pid: number;
  identity: string | null;
  verified: boolean;
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
    const lockTarget = await resolveProjectLockDaemon(
      options.configDir,
      options.projectId,
      options.workspaceDir
    );
    if (lockTarget) {
      return {
        running: true,
        target: lockTarget.target,
        source: "project-lock",
        expectedCwd: lockTarget.expectedCwd,
        pidPath,
        recordedPid: lockTarget.target.pid,
      };
    }
    return { running: false, reason: "missing-pid", pidPath };
  }

  const pidRecord = parseDaemonPidRecord(pidContents);
  if (!pidRecord) {
    const expectedCwd = resolve(options.workspaceDir);
    const lockTarget = await resolveProjectLockDaemon(
      options.configDir,
      options.projectId,
      options.workspaceDir
    );
    if (lockTarget) {
      return {
        running: true,
        target: lockTarget.target,
        source: "project-lock",
        expectedCwd: lockTarget.expectedCwd,
        pidPath,
        recordedPid: lockTarget.target.pid,
      };
    }
    return {
      running: false,
      reason: "invalid-pid",
      pidPath,
      pidContents,
      expectedCwd,
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
    options.workspaceDir
  );
  if (lockTarget) {
    return {
      running: true,
      target: lockTarget.target,
      source: "project-lock",
      expectedCwd: lockTarget.expectedCwd,
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
  return { pid, identity, verified: true };
}

async function resolveProjectLockDaemon(
  configDir: string,
  projectId: string,
  workspaceDir: string
): Promise<{ target: DaemonProcessTarget; expectedCwd: string } | null> {
  try {
    const lock = JSON.parse(
      await readFile(join(configDir, "projects", projectId, ".lock"), "utf8")
    ) as {
      pid?: unknown;
      processIdentity?: unknown;
      heartbeatAt?: unknown;
      cwd?: unknown;
    };
    if (!Number.isInteger(lock.pid) || (lock.pid as number) <= 0) {
      return null;
    }
    const processIdentity =
      typeof lock.processIdentity === "string" ? lock.processIdentity : null;
    const heartbeatAt =
      typeof lock.heartbeatAt === "string" ? lock.heartbeatAt : null;
    const expectedCwd = resolve(
      typeof lock.cwd === "string" ? lock.cwd : workspaceDir
    );
    const target = validateProjectLockProcess(
      lock.pid as number,
      processIdentity,
      heartbeatAt,
      expectedCwd
    );
    return target ? { target, expectedCwd } : null;
  } catch {
    return null;
  }
}

function validateProjectLockProcess(
  pid: number,
  recordedIdentity: string | null,
  heartbeatAt: string | null,
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
    : identity
      ? isLegacyOrchestratorIdentity(identity)
      : isFreshProjectLockHeartbeat(heartbeatAt);
  const cwd = getProcessCwd(pid);
  if (!identityMatches || !cwd || resolve(cwd) !== expectedCwd) {
    return null;
  }
  return { pid, identity, verified: identity !== null };
}

function isFreshProjectLockHeartbeat(heartbeatAt: string | null): boolean {
  if (!heartbeatAt) {
    return false;
  }
  const heartbeatAtMs = Date.parse(heartbeatAt);
  const ageMs = Date.now() - heartbeatAtMs;
  return (
    Number.isFinite(heartbeatAtMs) &&
    ageMs >= 0 &&
    ageMs <= PROJECT_LOCK_HEARTBEAT_MAX_AGE_MS
  );
}

function isLegacyOrchestratorIdentity(identity: string | null): boolean {
  return Boolean(
    identity &&
    /(?:gh-symphony|(?:^|\s)(?:(?:\S*\/)?dist\/)?index\.js)(?:\s|$)/.test(
      identity
    ) &&
    /\brepo\s+start\b/.test(identity)
  );
}

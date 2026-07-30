import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OrchestratorFsStore } from "./fs-store.js";
import { syncDirectory } from "./durable-file.js";

type ProjectLockRecord = {
  ownerToken: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string | null;
  processIdentity: string | null;
};

export type ProjectLockHandle = {
  lockPath: string;
  ownerToken: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  processIdentity: string | null;
};

type LeaseLostHandler = (error: Error) => void | Promise<void>;

const LOCK_READ_RETRY_DELAY_MS = 10;
const LOCK_READ_RETRY_LIMIT = 20;
const SECURE_DIRECTORY_MODE = 0o700;
export const DEFAULT_PROJECT_LOCK_LEASE_TTL_MS = 60_000;
const heartbeatTimers = new WeakMap<ProjectLockHandle, NodeJS.Timeout>();

export async function acquireProjectLock(input: {
  runtimeRoot: string;
  projectId: string;
  pid?: number;
  now?: Date;
  isProcessRunning?: (pid: number) => boolean;
  getProcessIdentity?: (pid: number) => string | null;
  leaseTtlMs?: number;
  onLeaseLost?: LeaseLostHandler;
}): Promise<ProjectLockHandle> {
  assertValidProjectId(input.projectId);
  const pid = input.pid ?? process.pid;
  const startedAt = (input.now ?? new Date()).toISOString();
  const heartbeatAt = startedAt;
  const processIdentity = (input.getProcessIdentity ?? getProcessIdentity)(pid);
  const ownerToken = `${pid}:${randomUUID()}`;
  const lockPath = resolveProjectLockPath(input.runtimeRoot, input.projectId);
  const record: ProjectLockRecord = {
    ownerToken,
    pid,
    startedAt,
    heartbeatAt,
    processIdentity,
  };
  let invalidReadAttempts = 0;

  for (;;) {
    try {
      await ensureSecureDirectory(dirname(lockPath));
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(lockPath));

      const lock = {
        lockPath,
        ownerToken,
        pid,
        startedAt,
        heartbeatAt,
        processIdentity,
      };
      startProjectLockHeartbeat(
        lock,
        input.leaseTtlMs ?? DEFAULT_PROJECT_LOCK_LEASE_TTL_MS,
        input.onLeaseLost ?? failClosedOnLeaseLoss
      );
      return lock;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    const existing = await readProjectLock(lockPath);
    if (existing.status === "missing") {
      invalidReadAttempts = 0;
      continue;
    }

    if (existing.status === "invalid") {
      invalidReadAttempts += 1;
      if (invalidReadAttempts >= LOCK_READ_RETRY_LIMIT) {
        throw new Error(
          `Project "${input.projectId}" lock file is unreadable at "${lockPath}".`
        );
      }

      await delay(LOCK_READ_RETRY_DELAY_MS);
      continue;
    }

    invalidReadAttempts = 0;
    if (
      isActiveLock(existing.record, {
        now: input.now ?? new Date(),
        leaseTtlMs: input.leaseTtlMs ?? DEFAULT_PROJECT_LOCK_LEASE_TTL_MS,
        isProcessRunning: input.isProcessRunning ?? isProcessRunning,
        getProcessIdentity: input.getProcessIdentity ?? getProcessIdentity,
      })
    ) {
      throw new Error(
        `Project "${input.projectId}" is already running (PID ${existing.record.pid}).`
      );
    }

    await rm(lockPath, { force: true });
  }
}

function startProjectLockHeartbeat(
  lock: ProjectLockHandle,
  leaseTtlMs: number,
  onLeaseLost: LeaseLostHandler
): void {
  const intervalMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));
  const timer = setInterval(() => {
    void renewProjectLock(lock)
      .then(async (renewed) => {
        if (renewed) {
          return;
        }

        stopProjectLockHeartbeat(lock);
        const error = new Error(
          `Lost ownership of project lock at "${lock.lockPath}".`
        );
        console.error(error.message);
        await onLeaseLost(error);
      })
      .catch((error) => {
        console.error(
          `Failed to renew project lock at "${lock.lockPath}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  }, intervalMs);
  timer.unref();
  heartbeatTimers.set(lock, timer);
}

function stopProjectLockHeartbeat(lock: ProjectLockHandle): void {
  const heartbeatTimer = heartbeatTimers.get(lock);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimers.delete(lock);
  }
}

function failClosedOnLeaseLoss(): void {
  process.exitCode = 1;
  process.kill(process.pid, "SIGTERM");
}

export async function renewProjectLock(
  lock: ProjectLockHandle,
  now = new Date()
): Promise<boolean> {
  let handle;
  try {
    handle = await open(lock.lockPath, "r+");
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }

  try {
    const existing = parseProjectLock(await handle.readFile("utf8"));
    if (!existing || existing.ownerToken !== lock.ownerToken) {
      return false;
    }

    const heartbeatAt = now.toISOString();
    const contents =
      JSON.stringify({ ...existing, heartbeatAt }, null, 2) + "\n";
    await overwriteOpenFile(handle, contents);
    lock.heartbeatAt = heartbeatAt;
    return true;
  } finally {
    await handle.close();
  }
}

async function overwriteOpenFile(
  handle: FileHandle,
  contents: string
): Promise<void> {
  const data = Buffer.from(contents);
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      offset
    );
    if (bytesWritten === 0) {
      throw new Error("Failed to make progress while renewing project lock.");
    }
    offset += bytesWritten;
  }
  await handle.truncate(data.length);
  await handle.sync();
}

function isActiveLock(
  record: ProjectLockRecord,
  input: {
    now: Date;
    leaseTtlMs: number;
    isProcessRunning: (pid: number) => boolean;
    getProcessIdentity: (pid: number) => string | null;
  }
): boolean {
  if (!input.isProcessRunning(record.pid)) {
    return false;
  }

  const actualIdentity = input.getProcessIdentity(record.pid);
  const identityMatches =
    record.processIdentity === null ||
    actualIdentity === null ||
    record.processIdentity === actualIdentity;
  if (!identityMatches) {
    return false;
  }

  // Locks written before heartbeat leases were introduced must remain active
  // while their recorded process is still alive. Otherwise a rolling upgrade
  // could mistake a long-running legacy daemon for an expired lease.
  if (record.heartbeatAt === null) {
    return true;
  }

  const heartbeatAtMs = Date.parse(record.heartbeatAt);
  const leaseAgeMs = input.now.getTime() - heartbeatAtMs;
  if (
    !Number.isFinite(heartbeatAtMs) ||
    Math.abs(leaseAgeMs) > input.leaseTtlMs
  ) {
    return false;
  }

  return true;
}

async function ensureSecureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  await chmod(path, SECURE_DIRECTORY_MODE);
}

export async function releaseProjectLock(
  lock: ProjectLockHandle | null | undefined
): Promise<void> {
  if (!lock) {
    return;
  }

  stopProjectLockHeartbeat(lock);

  try {
    const existing = await readProjectLock(lock.lockPath);
    if (
      existing.status !== "valid" ||
      existing.record.ownerToken !== lock.ownerToken
    ) {
      return;
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  await rm(lock.lockPath, { force: true });
}

async function readProjectLock(
  lockPath: string
): Promise<
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; record: ProjectLockRecord }
> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const record = parseProjectLock(raw);
    if (!record) {
      return { status: "invalid" };
    }

    return { status: "valid", record };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "missing" };
    }

    throw error;
  }
}

export function assertValidProjectId(projectId: string): void {
  if (
    projectId.length === 0 ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\")
  ) {
    throw new Error(
      `Invalid project ID "${projectId}". Project IDs must not contain path separators or traversal segments.`
    );
  }
}

function resolveProjectLockPath(
  runtimeRoot: string,
  projectId: string
): string {
  const store = new OrchestratorFsStore(runtimeRoot);
  const projectDir = resolve(store.projectDir(projectId));
  const resolvedRuntimeRoot = resolve(runtimeRoot);
  const relativeProjectDir = relative(resolvedRuntimeRoot, projectDir);

  if (relativeProjectDir.startsWith("..") || isAbsolute(relativeProjectDir)) {
    throw new Error(
      `Invalid project ID "${projectId}". Project lock path must stay within "${resolvedRuntimeRoot}".`
    );
  }

  return join(projectDir, ".lock");
}

function parseProjectLock(raw: string): ProjectLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectLockRecord>;
    if (
      typeof parsed.ownerToken !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== "string" ||
      (parsed.heartbeatAt !== undefined &&
        typeof parsed.heartbeatAt !== "string") ||
      (parsed.processIdentity !== undefined &&
        parsed.processIdentity !== null &&
        typeof parsed.processIdentity !== "string")
    ) {
      return null;
    }

    return {
      ownerToken: parsed.ownerToken,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      heartbeatAt: parsed.heartbeatAt ?? null,
      processIdentity: parsed.processIdentity ?? null,
    };
  } catch {
    return null;
  }
}

export function getProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    return null;
  }

  const identity = result.stdout.trim().replace(/\s+/g, " ");
  return identity.length > 0 ? identity : null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OrchestratorFsStore } from "./fs-store.js";

type ProjectLockRecord = {
  ownerToken: string;
  pid: number;
  startedAt: string;
};

export type ProjectLockHandle = {
  lockPath: string;
  ownerToken: string;
  pid: number;
  startedAt: string;
};

const LOCK_READ_RETRY_DELAY_MS = 10;
const LOCK_READ_RETRY_LIMIT = 20;

export async function acquireProjectLock(input: {
  runtimeRoot: string;
  projectId: string;
  pid?: number;
  now?: Date;
  isProcessRunning?: (pid: number) => boolean;
}): Promise<ProjectLockHandle> {
  assertValidProjectId(input.projectId);
  const pid = input.pid ?? process.pid;
  const startedAt = (input.now ?? new Date()).toISOString();
  const ownerToken = `${pid}:${randomUUID()}`;
  const lockPath = resolveProjectLockPath(input.runtimeRoot, input.projectId);
  const record: ProjectLockRecord = { ownerToken, pid, startedAt };
  let invalidReadAttempts = 0;

  for (;;) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
      } finally {
        await handle.close();
      }

      return { lockPath, ownerToken, pid, startedAt };
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
    if ((input.isProcessRunning ?? isProcessRunning)(existing.record.pid)) {
      throw new Error(
        `Project "${input.projectId}" is already running (PID ${existing.record.pid}).`
      );
    }

    await rm(lockPath, { force: true });
  }
}

export async function releaseProjectLock(
  lock: ProjectLockHandle | null | undefined
): Promise<void> {
  if (!lock) {
    return;
  }

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

function resolveProjectLockPath(runtimeRoot: string, projectId: string): string {
  const store = new OrchestratorFsStore(runtimeRoot);
  const projectsRoot = resolve(runtimeRoot, "orchestrator", "projects");
  const projectDir = resolve(store.projectDir(projectId));
  const relativeProjectDir = relative(projectsRoot, projectDir);

  if (
    relativeProjectDir.length === 0 ||
    relativeProjectDir.startsWith("..") ||
    isAbsolute(relativeProjectDir)
  ) {
    throw new Error(
      `Invalid project ID "${projectId}". Project lock path must stay within "${projectsRoot}".`
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
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }

    return {
      ownerToken: parsed.ownerToken,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
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

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export async function acquireProjectLock(input: {
  runtimeRoot: string;
  projectId: string;
  pid?: number;
  now?: Date;
  isProcessRunning?: (pid: number) => boolean;
}): Promise<ProjectLockHandle> {
  const pid = input.pid ?? process.pid;
  const startedAt = (input.now ?? new Date()).toISOString();
  const ownerToken = `${pid}:${randomUUID()}`;
  const store = new OrchestratorFsStore(input.runtimeRoot);
  const lockPath = join(store.projectDir(input.projectId), ".lock");
  const record: ProjectLockRecord = { ownerToken, pid, startedAt };

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
    if (
      existing &&
      (input.isProcessRunning ?? isProcessRunning)(existing.pid)
    ) {
      throw new Error(
        `Project "${input.projectId}" is already running (PID ${existing.pid}).`
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
    if (!existing || existing.ownerToken !== lock.ownerToken) {
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
): Promise<ProjectLockRecord | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return parseProjectLock(raw);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
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

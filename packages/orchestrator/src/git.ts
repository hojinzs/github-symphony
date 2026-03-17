import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  createInvalidWorkflowResolution,
  createDefaultWorkflowResolution,
  WorkflowConfigStore,
  type RepositoryRef,
  type WorkflowResolution,
} from "@gh-symphony/core";

const workflowConfigStore = new WorkflowConfigStore();
const LOCK_RETRY_MS = 100;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;

export type RepositorySyncResult = {
  repositoryDirectory: string;
  changed: boolean;
};

export async function cloneRepositoryForRun(input: {
  repository: RepositoryRef;
  targetDirectory: string;
}): Promise<string> {
  const result = await syncRepositoryForRun(input);
  return result.repositoryDirectory;
}

export async function syncRepositoryForRun(input: {
  repository: RepositoryRef;
  targetDirectory: string;
}): Promise<RepositorySyncResult> {
  await mkdir(input.targetDirectory, { recursive: true });
  const repositoryDirectory = join(input.targetDirectory, "repository");
  const lockDirectory = join(input.targetDirectory, "repository.lock");

  return withRepositoryLock(lockDirectory, async () => {
    // Check if the repository directory already has a valid .git
    let hasGit = false;
    try {
      await access(join(repositoryDirectory, ".git"), constants.R_OK);
      hasGit = true;
    } catch {
      // .git not accessible
    }

    if (hasGit) {
      try {
        const beforeHead = await readGitHead(repositoryDirectory);
        await runCommand("git", [
          "-C",
          repositoryDirectory,
          "pull",
          "--ff-only",
        ]);
        const afterHead = await readGitHead(repositoryDirectory);
        return {
          repositoryDirectory,
          changed: beforeHead !== afterHead,
        };
      } catch {
        // Pull failed — remove the corrupted/stale directory and re-clone
        await rm(repositoryDirectory, { recursive: true, force: true });
      }
    } else {
      // Partial clone debris can leave a non-empty directory without .git.
      await rm(repositoryDirectory, { recursive: true, force: true });
    }

    const tempRepositoryDirectory = join(
      input.targetDirectory,
      `repository.tmp-${process.pid}-${Date.now()}`
    );
    await rm(tempRepositoryDirectory, { recursive: true, force: true });

    try {
      await runCommand("git", [
        "clone",
        "--depth",
        "1",
        input.repository.cloneUrl,
        tempRepositoryDirectory,
      ]);
      await rename(tempRepositoryDirectory, repositoryDirectory);
      return {
        repositoryDirectory,
        changed: true,
      };
    } finally {
      await rm(tempRepositoryDirectory, { recursive: true, force: true });
    }
  });
}

export async function ensureIssueWorkspaceRepository(input: {
  repository: RepositoryRef;
  issueWorkspacePath: string;
}): Promise<string> {
  return cloneRepositoryForRun({
    repository: input.repository,
    targetDirectory: input.issueWorkspacePath,
  });
}

export async function loadRepositoryWorkflow(
  repositoryDirectory: string,
  _repository: RepositoryRef
): Promise<WorkflowResolution> {
  const workflowPath = join(repositoryDirectory, "WORKFLOW.md");

  try {
    return await workflowConfigStore.load(workflowPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return createDefaultWorkflowResolution();
    }

    return createInvalidWorkflowResolution(
      workflowPath,
      error instanceof Error ? error.message : "workflow_parse_error"
    );
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          stderr.trim() || `${command} exited with code ${code ?? "unknown"}`
        )
      );
    });
  });
}

async function readGitHead(repositoryDirectory: string): Promise<string | null> {
  try {
    return await runCommandCapture("git", [
      "-C",
      repositoryDirectory,
      "rev-parse",
      "HEAD",
    ]);
  } catch {
    return null;
  }
}

function runCommandCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(
          stderr.trim() || `${command} exited with code ${code ?? "unknown"}`
        )
      );
    });
  });
}

async function withRepositoryLock<T>(
  lockDirectory: string,
  fn: () => Promise<T>
): Promise<T> {
  const ownerToken = await acquireRepositoryLock(lockDirectory);
  try {
    return await fn();
  } finally {
    await releaseRepositoryLock(lockDirectory, ownerToken);
  }
}

export async function acquireRepositoryLock(
  lockDirectory: string
): Promise<string> {
  const startedAt = Date.now();
  const ownerToken = `${process.pid}:${randomUUID()}`;

  for (;;) {
    try {
      await mkdir(lockDirectory);
      await writeFile(
        join(lockDirectory, "owner"),
        `${ownerToken}\n${new Date().toISOString()}\n`,
        "utf8"
      );
      return ownerToken;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    const stale = await isStaleLock(lockDirectory);
    if (stale) {
      await rm(lockDirectory, { recursive: true, force: true });
      continue;
    }

    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for repository cache lock: ${lockDirectory}`
      );
    }

    await wait(LOCK_RETRY_MS);
  }
}

export async function releaseRepositoryLock(
  lockDirectory: string,
  ownerToken: string
): Promise<void> {
  try {
    const owner = await readLockOwner(lockDirectory);
    if (owner !== ownerToken) {
      return;
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }

  await rm(lockDirectory, { recursive: true, force: true });
}

async function isStaleLock(lockDirectory: string): Promise<boolean> {
  try {
    const details = await stat(lockDirectory);
    return Date.now() - details.mtimeMs >= LOCK_STALE_MS;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
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

async function readLockOwner(lockDirectory: string): Promise<string | null> {
  await access(join(lockDirectory, "owner"), constants.R_OK);
  const owner = await readFile(join(lockDirectory, "owner"), "utf8");
  return owner.split("\n", 1)[0] || null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

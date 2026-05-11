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

export type PullRequestBranchCheckoutTarget = {
  headRefName: string;
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
  existingWorkspace: boolean;
  pullRequestBranch?: PullRequestBranchCheckoutTarget | null;
}): Promise<string> {
  const repositoryDirectory = input.existingWorkspace
    ? await syncExistingIssueWorkspaceRepository({
        ...input,
        skipPull: Boolean(input.pullRequestBranch),
      })
    : await cloneRepositoryForRun({
        repository: input.repository,
        targetDirectory: input.issueWorkspacePath,
      });

  if (input.pullRequestBranch) {
    await checkoutPullRequestBranch(
      repositoryDirectory,
      input.pullRequestBranch
    );
  }

  return repositoryDirectory;
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

async function readGitHead(
  repositoryDirectory: string
): Promise<string | null> {
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

async function syncExistingIssueWorkspaceRepository(input: {
  repository: RepositoryRef;
  issueWorkspacePath: string;
  skipPull?: boolean;
}): Promise<string> {
  await mkdir(input.issueWorkspacePath, { recursive: true });
  const repositoryDirectory = join(input.issueWorkspacePath, "repository");
  const lockDirectory = join(input.issueWorkspacePath, "repository.lock");

  return withRepositoryLock(lockDirectory, async () => {
    const repositoryExists = await pathExists(repositoryDirectory);
    const hasGit = await pathExists(join(repositoryDirectory, ".git"));

    if (hasGit) {
      let dirtyStatus: string;
      try {
        dirtyStatus = await readGitStatusPorcelain(repositoryDirectory);
      } catch (error) {
        throw createIssueWorkspacePreservedError(
          repositoryDirectory,
          `could not be inspected: ${formatCommandError(error, "git status --porcelain failed")}`
        );
      }

      if (dirtyStatus.trim()) {
        throw createIssueWorkspacePreservedError(
          repositoryDirectory,
          `has uncommitted changes: ${summarizeGitStatus(dirtyStatus)}`
        );
      }

      if (!input.skipPull) {
        try {
          await runCommand("git", [
            "-C",
            repositoryDirectory,
            "pull",
            "--ff-only",
          ]);
        } catch (error) {
          const message = formatCommandError(
            error,
            "git pull --ff-only failed"
          );
          throw createIssueWorkspacePreservedError(
            repositoryDirectory,
            `could not be fast-forwarded: ${message}`
          );
        }
      }

      return repositoryDirectory;
    }

    if (repositoryExists) {
      throw createIssueWorkspacePreservedError(
        repositoryDirectory,
        "exists but is not a git checkout"
      );
    }

    const tempRepositoryDirectory = join(
      input.issueWorkspacePath,
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
      return repositoryDirectory;
    } finally {
      await rm(tempRepositoryDirectory, { recursive: true, force: true });
    }
  });
}

async function checkoutPullRequestBranch(
  repositoryDirectory: string,
  target: PullRequestBranchCheckoutTarget
): Promise<void> {
  const branchName = target.headRefName.trim();

  if (!branchName) {
    throw new Error(
      "Cannot checkout pull request branch because headRefName is empty."
    );
  }

  try {
    await runCommand("git", ["check-ref-format", "--branch", branchName]);
  } catch (error) {
    throw new Error(
      `Cannot checkout pull request branch ${branchName}: invalid branch name (${formatCommandError(error, "git check-ref-format failed")}).`
    );
  }

  const remoteRef = `refs/remotes/origin/${branchName}`;
  try {
    await runCommand("git", [
      "-C",
      repositoryDirectory,
      "fetch",
      "origin",
      `+refs/heads/${branchName}:${remoteRef}`,
      "--depth",
      "1",
    ]);
  } catch (error) {
    throw new Error(
      `Cannot checkout pull request branch ${branchName}: git fetch origin ${branchName} failed (${formatCommandError(error, "git fetch failed")}).`
    );
  }

  try {
    await runCommand("git", [
      "-C",
      repositoryDirectory,
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
  } catch (error) {
    throw new Error(
      `Cannot checkout pull request branch ${branchName}: git config remote.origin.fetch failed (${formatCommandError(error, "git config failed")}).`
    );
  }

  try {
    await runCommand("git", [
      "-C",
      repositoryDirectory,
      "checkout",
      "-B",
      branchName,
      remoteRef,
    ]);
  } catch (error) {
    throw new Error(
      `Cannot checkout pull request branch ${branchName}: git checkout failed (${formatCommandError(error, "git checkout failed")}).`
    );
  }

  try {
    await runCommand("git", [
      "-C",
      repositoryDirectory,
      "branch",
      "--set-upstream-to",
      `origin/${branchName}`,
      branchName,
    ]);
  } catch (error) {
    throw new Error(
      `Cannot checkout pull request branch ${branchName}: git branch --set-upstream-to failed (${formatCommandError(error, "git branch --set-upstream-to failed")}).`
    );
  }
}

function createIssueWorkspacePreservedError(
  repositoryDirectory: string,
  reason: string
): Error {
  return new Error(
    [
      `Issue workspace repository at ${repositoryDirectory} was preserved because it ${reason}.`,
      "Resolve or commit the local workspace changes, or run a configured recovery hook, before retrying.",
    ].join(" ")
  );
}

function formatCommandError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return normalizeWhitespace(message) || fallback;
}

function summarizeGitStatus(status: string): string {
  const lines = status
    .trim()
    .split(/\r?\n/)
    .map(normalizeWhitespace)
    .filter(Boolean);
  const summary = lines.slice(0, 5).join("; ");
  return lines.length > 5 ? `${summary}; ...` : summary;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function readGitStatusPorcelain(
  repositoryDirectory: string
): Promise<string> {
  return runCommandCapture("git", [
    "-C",
    repositoryDirectory,
    "status",
    "--porcelain",
  ]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  createInvalidWorkflowResolution,
  createDefaultWorkflowResolution,
  formatWorkflowValidationError,
  WorkflowConfigStore,
  type OrchestratorTrackerAdapter,
  type RepositoryRef,
  type WorkflowResolution,
} from "@gh-symphony/core";
import { getSupportedTrackerKinds } from "./tracker-adapters.js";

const defaultWorkflowConfigStore = new WorkflowConfigStore({
  supportedTrackerKinds: getSupportedTrackerKinds(),
});
type WorkflowTrackerAdapterHooks = Pick<
  OrchestratorTrackerAdapter,
  "validateProviderConfig" | "defaultLifecycle" | "secretEnvironmentNames"
>;
const workflowConfigStores = new WeakMap<
  WorkflowTrackerAdapterHooks,
  WorkflowConfigStore
>();
const LOCK_RETRY_MS = 100;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;

export type RepositoryLockHeartbeat = {
  stop: () => Promise<void>;
};

export type PullRequestBranchCheckoutTarget = {
  headRefName: string;
};

export async function ensureIssueWorkspaceRepository(input: {
  repository: RepositoryRef;
  issueWorkspacePath: string;
  existingWorkspace: boolean;
}): Promise<string> {
  const repositoryDirectory = join(input.issueWorkspacePath, "repository");
  if (!input.existingWorkspace) {
    await mkdir(repositoryDirectory, { recursive: true, mode: 0o700 });
  }
  return repositoryDirectory;
}

export function renderIssueBranchName(input: {
  template?: string | null;
  projectSlug: string;
  issueIdentifier: string;
}): string {
  const projectSlug = sanitizeBranchSegment(input.projectSlug);
  const issueId = sanitizeBranchSegment(input.issueIdentifier);
  const template =
    input.template?.trim() || "symphony/{project_slug}/{sanitized_issue_id}";
  const branch = template
    .replaceAll("{project_slug}", projectSlug)
    .replaceAll("{sanitized_issue_id}", issueId);
  if (!branch || branch.includes("{") || branch.includes("}")) {
    throw new Error(
      `Invalid issue worktree branch template ${JSON.stringify(template)}.`
    );
  }
  return branch;
}

function sanitizeBranchSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(
      `Cannot derive a worktree branch segment from ${JSON.stringify(value)}.`
    );
  }
  return sanitized;
}

export type IssueWorkspaceDirtyStatus = {
  repositoryDirectory: string;
  dirty: boolean;
  dirtyFiles: string[];
  summary: string | null;
};

export async function inspectIssueWorkspaceDirtyStatus(input: {
  issueWorkspacePath: string;
}): Promise<IssueWorkspaceDirtyStatus | null> {
  const repositoryDirectory = join(input.issueWorkspacePath, "repository");
  const hasGit = await pathExists(join(repositoryDirectory, ".git"));
  if (!hasGit) {
    return null;
  }

  const status = await readGitStatusPorcelain(repositoryDirectory);
  return {
    repositoryDirectory,
    dirty: status.trim().length > 0,
    dirtyFiles: parseGitStatusFiles(status),
    summary: status.trim() ? summarizeGitStatus(status) : null,
  };
}

export async function readGitCurrentBranch(
  repositoryDirectory: string
): Promise<string | null> {
  try {
    const branch = await runCommandCapture("git", [
      "-C",
      repositoryDirectory,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const trimmed = branch.trim();
    return trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Preserve a workspace whose dirty state cannot be attributed to the run's
 * issue by renaming it out of the active workspace path. Returns the
 * quarantine directory, or null when the workspace no longer exists.
 */
export async function quarantineIssueWorkspace(
  issueWorkspacePath: string,
  now: Date = new Date()
): Promise<string | null> {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${issueWorkspacePath}.quarantine-${timestamp}`;
  try {
    await rename(issueWorkspacePath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  return quarantinePath;
}

export async function loadRepositoryWorkflow(
  repositoryDirectory: string,
  _repository: RepositoryRef,
  env: NodeJS.ProcessEnv = process.env,
  trackerAdapter?: WorkflowTrackerAdapterHooks
): Promise<WorkflowResolution> {
  return loadWorkflowFile(
    join(repositoryDirectory, "WORKFLOW.md"),
    env,
    trackerAdapter
  );
}

/** Load a workflow from an explicitly selected file without repository lookup. */
export async function loadWorkflowFile(
  workflowPath: string,
  env: NodeJS.ProcessEnv = process.env,
  trackerAdapter?: WorkflowTrackerAdapterHooks
): Promise<WorkflowResolution> {
  try {
    return await getWorkflowConfigStore(trackerAdapter).load(workflowPath, env);
  } catch (error) {
    if (isMissingFileError(error)) {
      return createDefaultWorkflowResolution();
    }

    return createInvalidWorkflowResolution(
      workflowPath,
      formatWorkflowValidationError(error)
    );
  }
}

function getWorkflowConfigStore(
  trackerAdapter?: WorkflowTrackerAdapterHooks
): WorkflowConfigStore {
  if (!trackerAdapter) {
    return defaultWorkflowConfigStore;
  }

  let store = workflowConfigStores.get(trackerAdapter);
  if (!store) {
    store = new WorkflowConfigStore({
      supportedTrackerKinds: getSupportedTrackerKinds(),
      trackerAdapter,
    });
    workflowConfigStores.set(trackerAdapter, store);
  }
  return store;
}

export function runGitCommand(args: string[]): Promise<void> {
  return runCommand("git", args);
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

function summarizeGitStatus(status: string): string {
  const lines = status
    .trim()
    .split(/\r?\n/)
    .map(normalizeWhitespace)
    .filter(Boolean);
  const summary = lines.slice(0, 5).join("; ");
  return lines.length > 5 ? `${summary}; ...` : summary;
}

function parseGitStatusFiles(status: string): string[] {
  return status
    .trim()
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
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

export function runGitCommandCapture(args: string[]): Promise<string> {
  return runCommandCapture("git", args);
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

    const stale = await isRepositoryLockStale(lockDirectory);
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

/** Attempts lock acquisition once; maintenance callers use this to skip busy caches. */
export async function tryAcquireRepositoryLock(
  lockDirectory: string,
  options: { breakStale?: boolean } = {}
): Promise<string | null> {
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

    if (!options.breakStale || !(await isRepositoryLockStale(lockDirectory))) {
      return null;
    }
    await rm(lockDirectory, { recursive: true, force: true });
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

/**
 * Keeps a long-running lock lease fresh without changing the generic lock's
 * stale timeout. Ownership is checked before every touch so a replaced lock is
 * never intentionally renewed by its previous holder.
 */
export function startRepositoryLockHeartbeat(
  lockDirectory: string,
  ownerToken: string,
  intervalMs = 60_000
): RepositoryLockHeartbeat {
  let stopped = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (stopped || (await readLockOwner(lockDirectory)) !== ownerToken) {
          return;
        }
        const now = new Date();
        await utimes(lockDirectory, now, now);
      })
      .catch(() => {
        // The cache operation itself remains authoritative. A removed or
        // inaccessible lock will be handled by its normal failure path.
      });
  }, intervalMs);
  timer.unref();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await heartbeat;
    },
  };
}

export async function isRepositoryLockStale(
  lockDirectory: string
): Promise<boolean> {
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

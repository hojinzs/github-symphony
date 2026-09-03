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
import {
  RepositoryCacheUnavailableError,
  withGlobalBareRepositoryCache,
} from "./repository-cache.js";
import { sanitizeRepositoryCloneUrl } from "./repository-url.js";
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
  requiredRef?: string;
  onCacheUnavailable?: (error: RepositoryCacheUnavailableError) => void;
}): Promise<string> {
  const result = await syncRepositoryForRun(input);
  return result.repositoryDirectory;
}

export async function syncRepositoryForRun(input: {
  repository: RepositoryRef;
  targetDirectory: string;
  requiredRef?: string;
  onCacheUnavailable?: (error: RepositoryCacheUnavailableError) => void;
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
        await migrateShallowRepository(repositoryDirectory);
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
      try {
        await withGlobalBareRepositoryCache(
          {
            repository: input.repository,
            requiredRef: input.requiredRef,
          },
          async (bareRepositoryDirectory) => {
            await runCommand("git", [
              "clone",
              "--filter=blob:none",
              "--reference-if-able",
              bareRepositoryDirectory,
              "--dissociate",
              sanitizeRepositoryCloneUrl(input.repository.cloneUrl),
              tempRepositoryDirectory,
            ]);
          }
        );
      } catch (error) {
        if (!(error instanceof RepositoryCacheUnavailableError)) {
          throw error;
        }
        input.onCacheUnavailable?.(error);
        await cloneRepositoryDirectly(
          input.repository,
          tempRepositoryDirectory
        );
      }
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
  allowDirtyExistingWorkspace?: boolean;
  populateStrategy?: "clone" | "worktree-cache";
  projectSlug?: string;
  issueIdentifier?: string;
  branchTemplate?: string | null;
  baseBranch?: string | null;
  onCacheUnavailable?: (error: RepositoryCacheUnavailableError) => void;
}): Promise<string> {
  if (input.populateStrategy === "worktree-cache") {
    return ensureIssueWorkspaceWorktree(input);
  }
  let dirtyExistingWorkspaceAllowed = false;
  const repositoryDirectory = input.existingWorkspace
    ? await syncExistingIssueWorkspaceRepository(
        {
          ...input,
          skipPull: Boolean(input.pullRequestBranch),
          allowDirty: input.allowDirtyExistingWorkspace,
        },
        (dirtyAllowed) => {
          dirtyExistingWorkspaceAllowed = dirtyAllowed;
        }
      )
    : await cloneRepositoryForRun({
        repository: input.repository,
        targetDirectory: input.issueWorkspacePath,
        requiredRef: input.pullRequestBranch
          ? `refs/heads/${input.pullRequestBranch.headRefName}`
          : undefined,
        onCacheUnavailable: input.onCacheUnavailable,
      });

  if (input.pullRequestBranch && !dirtyExistingWorkspaceAllowed) {
    await checkoutPullRequestBranch(
      repositoryDirectory,
      input.pullRequestBranch
    );
  }

  return repositoryDirectory;
}

export async function removeIssueWorkspaceWorktree(input: {
  repository: RepositoryRef;
  repositoryDirectory: string;
  projectSlug: string;
  issueIdentifier: string;
  onBranchCleanup?: (result: AgentBranchCleanupResult) => void;
}): Promise<void> {
  if (await isDirectory(join(input.repositoryDirectory, ".git"))) {
    return;
  }
  await withGlobalBareRepositoryCache(
    { repository: input.repository },
    async (bare) => {
      await ignoreMissingWorktree(
        runGitCommand([
          "-C",
          bare,
          "worktree",
          "remove",
          "--force",
          input.repositoryDirectory,
        ])
      );
      await runGitCommand(["-C", bare, "worktree", "prune"]);
      for (const result of await pruneReachableAgentBranches(bare)) {
        input.onBranchCleanup?.(result);
      }
    }
  );
}

export type AgentBranchCleanupResult = {
  branch: string;
  outcome: "deleted" | "retained";
  reason: "linked-worktree" | "unreachable-from-origin" | "ref-changed" | null;
};

/**
 * Removes cache-local agent branches only after their complete history is
 * already retained by an origin tracking ref. The bare cache is shared, so a
 * branch with an unpushed tip must remain available for recovery indefinitely.
 */
async function pruneReachableAgentBranches(
  bareDirectory: string
): Promise<AgentBranchCleanupResult[]> {
  const branches = await listLocalBranchRefs(bareDirectory);
  const linkedBranches = await listLinkedWorktreeBranches(bareDirectory);
  const results: AgentBranchCleanupResult[] = branches
    .filter((branch) => linkedBranches.has(branch.name))
    .map((branch) => ({
      branch: branch.name,
      outcome: "retained" as const,
      reason: "linked-worktree" as const,
    }));
  const candidates = branches.filter(
    (branch) => !linkedBranches.has(branch.name)
  );
  if (candidates.length === 0) return results;

  // The cache may have skipped its TTL-bound fetch. Refresh and prune the
  // tracking refs before treating one as proof that a local branch is durable.
  await runGitCommand([
    "-C",
    bareDirectory,
    "fetch",
    "origin",
    "--prune",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  const refreshedLinkedBranches =
    await listLinkedWorktreeBranches(bareDirectory);

  for (const branch of candidates) {
    if (refreshedLinkedBranches.has(branch.name)) {
      results.push({
        branch: branch.name,
        outcome: "retained",
        reason: "linked-worktree",
      });
      continue;
    }
    const reachable = await isReachableFromOrigin(bareDirectory, branch.oid);
    if (!reachable) {
      results.push({
        branch: branch.name,
        outcome: "retained",
        reason: "unreachable-from-origin",
      });
      continue;
    }
    // `branch -D` can discard commits; `branch -d` checks against the bare
    // repository's HEAD rather than the origin refs we intentionally use as
    // the durability proof. Delete the exact ref only after that proof.
    try {
      await runGitCommand([
        "-C",
        bareDirectory,
        "update-ref",
        "-d",
        `refs/heads/${branch.name}`,
        branch.oid,
      ]);
      results.push({ branch: branch.name, outcome: "deleted", reason: null });
    } catch {
      results.push({
        branch: branch.name,
        outcome: "retained",
        reason: "ref-changed",
      });
    }
  }
  return results;
}

type LocalBranchRef = { name: string; oid: string };

async function listLocalBranchRefs(
  bareDirectory: string
): Promise<LocalBranchRef[]> {
  const output = await runGitCommandCapture([
    "-C",
    bareDirectory,
    "for-each-ref",
    "--format=%(refname:strip=2) %(objectname)",
    "refs/heads/",
  ]);
  return output
    .split("\n")
    .map((ref) => ref.trim().split(" "))
    .filter(([name, oid]) => Boolean(name && oid))
    .map(([name, oid]) => ({ name, oid }));
}

async function listLinkedWorktreeBranches(
  bareDirectory: string
): Promise<Set<string>> {
  const output = await runGitCommandCapture([
    "-C",
    bareDirectory,
    "worktree",
    "list",
    "--porcelain",
  ]);
  return new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length))
  );
}

async function isReachableFromOrigin(
  bareDirectory: string,
  branchOid: string
): Promise<boolean> {
  const output = await runGitCommandCapture([
    "-C",
    bareDirectory,
    "rev-list",
    "--max-count=1",
    branchOid,
    "--not",
    "--remotes=origin",
  ]);
  return output.trim() === "";
}

async function ensureIssueWorkspaceWorktree(input: {
  repository: RepositoryRef;
  issueWorkspacePath: string;
  existingWorkspace: boolean;
  pullRequestBranch?: PullRequestBranchCheckoutTarget | null;
  projectSlug?: string;
  issueIdentifier?: string;
  branchTemplate?: string | null;
  baseBranch?: string | null;
  onCacheUnavailable?: (error: RepositoryCacheUnavailableError) => void;
}): Promise<string> {
  const repositoryDirectory = join(input.issueWorkspacePath, "repository");
  if (await pathExists(join(repositoryDirectory, ".git"))) {
    return repositoryDirectory;
  }
  if (input.existingWorkspace && (await pathExists(repositoryDirectory))) {
    throw createIssueWorkspacePreservedError(
      repositoryDirectory,
      "exists but is not a git worktree"
    );
  }
  if (!input.projectSlug || !input.issueIdentifier) {
    throw new Error(
      "worktree-cache populate requires projectSlug and issueIdentifier."
    );
  }

  const branch = renderIssueBranchName({
    template: input.branchTemplate,
    projectSlug: input.projectSlug,
    issueIdentifier: input.issueIdentifier,
  });
  const repositoryDirectoryExisted = await pathExists(repositoryDirectory);
  await mkdir(input.issueWorkspacePath, { recursive: true });
  try {
    try {
      return await withGlobalBareRepositoryCache(
        {
          repository: input.repository,
          requiredRef: input.pullRequestBranch
            ? `refs/remotes/origin/${input.pullRequestBranch.headRefName}`
            : input.baseBranch
              ? `refs/remotes/origin/${input.baseBranch}`
              : undefined,
        },
        async (bare) => {
          const baseBranch =
            input.pullRequestBranch?.headRefName ??
            input.baseBranch ??
            (await readOriginDefaultBranch(bare));
          const baseRef = `refs/remotes/origin/${baseBranch}`;
          await runGitCommand(["-C", bare, "worktree", "prune"]);
          if (await hasLocalBranch(bare, branch)) {
            await runGitCommand([
              "-C",
              bare,
              "worktree",
              "add",
              repositoryDirectory,
              branch,
            ]);
          } else {
            await runGitCommand([
              "-C",
              bare,
              "worktree",
              "add",
              "-B",
              branch,
              repositoryDirectory,
              baseRef,
            ]);
          }
          return repositoryDirectory;
        }
      );
    } catch (error) {
      if (!(error instanceof RepositoryCacheUnavailableError)) {
        throw error;
      }
      input.onCacheUnavailable?.(error);
      await cloneRepositoryDirectly(input.repository, repositoryDirectory);
      const baseBranch =
        input.pullRequestBranch?.headRefName ??
        input.baseBranch ??
        (await readOriginDefaultBranch(repositoryDirectory));
      await runGitCommand([
        "-C",
        repositoryDirectory,
        "checkout",
        "-B",
        branch,
        `refs/remotes/origin/${baseBranch}`,
      ]);
      return repositoryDirectory;
    }
  } catch (error) {
    if (!repositoryDirectoryExisted) {
      await rm(repositoryDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function hasLocalBranch(
  bareDirectory: string,
  branch: string
): Promise<boolean> {
  try {
    await runGitCommand([
      "-C",
      bareDirectory,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function cloneRepositoryDirectly(
  repository: RepositoryRef,
  targetDirectory: string
): Promise<void> {
  await runCommand("git", [
    "clone",
    "--filter=blob:none",
    sanitizeRepositoryCloneUrl(repository.cloneUrl),
    targetDirectory,
  ]);
}

async function ignoreMissingWorktree(command: Promise<void>): Promise<void> {
  try {
    await command;
  } catch (error) {
    if (!hasGitError(error, "is not a working tree")) {
      throw error;
    }
  }
}

function hasGitError(error: unknown, message: string): boolean {
  return error instanceof Error && error.message.includes(message);
}

async function readOriginDefaultBranch(bareDirectory: string): Promise<string> {
  const ref = (
    await runGitCommandCapture([
      "-C",
      bareDirectory,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ])
  ).trim();
  if (!ref.startsWith("origin/")) {
    throw new Error(`Could not determine origin default branch from ${ref}.`);
  }
  return ref.slice("origin/".length);
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

async function syncExistingIssueWorkspaceRepository(
  input: {
    repository: RepositoryRef;
    issueWorkspacePath: string;
    skipPull?: boolean;
    allowDirty?: boolean;
  },
  onDirtyAllowed?: (dirtyAllowed: boolean) => void
): Promise<string> {
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

      try {
        await migrateShallowRepository(repositoryDirectory);
      } catch (error) {
        throw createIssueWorkspacePreservedError(
          repositoryDirectory,
          `could not be migrated from a shallow checkout: ${formatCommandError(error, "git fetch --unshallow failed")}`
        );
      }

      if (dirtyStatus.trim() && input.allowDirty) {
        onDirtyAllowed?.(true);
        return repositoryDirectory;
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
        "--filter=blob:none",
        sanitizeRepositoryCloneUrl(input.repository.cloneUrl),
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
      "--filter=blob:none",
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

async function migrateShallowRepository(
  repositoryDirectory: string
): Promise<void> {
  const isShallow = await runCommandCapture("git", [
    "-C",
    repositoryDirectory,
    "rev-parse",
    "--is-shallow-repository",
  ]);

  if (isShallow.trim() !== "true") {
    return;
  }

  await runCommand("git", [
    "-C",
    repositoryDirectory,
    "fetch",
    "--unshallow",
    "--filter=blob:none",
    "origin",
  ]);
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

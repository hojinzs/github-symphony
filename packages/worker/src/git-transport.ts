import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  RunAttemptPhase,
  SessionExitClassification,
  UnpublishedWorktree,
} from "@gh-symphony/core";
import { createGitCredentialHelperEnvironment } from "@gh-symphony/runtime-codex";

const execFileAsync = promisify(execFile);

export type GitTransportResult = {
  branch: string;
  pushed: boolean;
  head: string;
  unpublishedWorktreeChanges: {
    tracked: string[];
    untracked: string[];
    trackedOmitted: number;
    untrackedOmitted: number;
  } | null;
};

export type GitTransportAttempt =
  | { ok: true; result: GitTransportResult }
  | { ok: false; error: string };

export type GitTransportLifecycleState = {
  status: "idle" | "starting" | "running" | "failed" | "completed";
  runPhase: RunAttemptPhase | null;
  lastError: string | null;
  unpublishedWorktree: UnpublishedWorktree | null;
  exitClassification: SessionExitClassification | null;
};

export function applyGitTransportAttempt(
  state: GitTransportLifecycleState,
  attempt: GitTransportAttempt,
  writeStderr: (message: string) => void = (message) =>
    process.stderr.write(message)
): 0 | 1 {
  if (attempt.ok) {
    const unpublished = attempt.result.unpublishedWorktreeChanges;
    if (unpublished) {
      state.lastError = null;
      state.unpublishedWorktree = {
        branch: attempt.result.branch,
        head: attempt.result.head,
        ...unpublished,
      };
      writeStderr(
        `[worker] host Git transport pushed ${attempt.result.branch} at ${attempt.result.head}, but tracked or untracked work remains unpublished\n`
      );
      return 0;
    }
    state.unpublishedWorktree = null;
    writeStderr(
      `[worker] host Git transport pushed ${attempt.result.branch} at ${attempt.result.head}\n`
    );
    return 0;
  }

  state.status = "failed";
  state.runPhase = "failed";
  state.lastError = `git_transport_failed: ${attempt.error}`;
  state.unpublishedWorktree = null;
  state.exitClassification = "error";
  writeStderr(`[worker] host Git transport failed: ${attempt.error}\n`);
  return 1;
}

export async function synchronizeAssignedBranch(options: {
  cwd: string;
  assignedBranch: string;
  remoteUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitTransportResult> {
  const hostEnv = buildHostGitEnvironment(options.env ?? process.env);
  const branch = options.assignedBranch.trim();
  if (!branch) {
    throw new Error("assigned Git branch is not set");
  }
  const remoteUrl = options.remoteUrl.trim();
  if (!remoteUrl) {
    throw new Error("assigned Git remote URL is not set");
  }

  const transportDirectory = await mkdtemp(
    join(tmpdir(), "gh-symphony-git-transport-")
  );
  try {
    const workspaceEnv = buildWorkspaceGitEnvironment(
      options.env ?? process.env,
      transportDirectory
    );
    await runGit(options.cwd, workspaceEnv, [
      "check-ref-format",
      "--branch",
      branch,
    ]);
    const currentBranch = await readCurrentBranch(options.cwd, workspaceEnv);
    if (!currentBranch) {
      throw new Error(
        "refusing to push: assigned worktree is in detached HEAD state"
      );
    }
    if (currentBranch !== branch) {
      throw new Error(
        `refusing to push: worktree is on ${currentBranch}, expected assigned branch ${branch}`
      );
    }
    const localRef = `refs/heads/${branch}`;
    const head = (
      await runGit(options.cwd, workspaceEnv, ["rev-parse", localRef])
    ).trim();

    await runGit(transportDirectory, workspaceEnv, ["init", "--bare", "."]);
    await runGit(transportDirectory, workspaceEnv, [
      "fetch",
      "--no-tags",
      resolve(options.cwd),
      `${localRef}:${localRef}`,
    ]);

    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteListing = await runGit(transportDirectory, hostEnv, [
      "ls-remote",
      "--heads",
      remoteUrl,
      `refs/heads/${branch}`,
    ]);
    if (remoteListing.trim()) {
      await runGit(transportDirectory, hostEnv, [
        "fetch",
        "--no-tags",
        remoteUrl,
        `+refs/heads/${branch}:${remoteRef}`,
      ]);
      try {
        await runGit(transportDirectory, hostEnv, [
          "merge-base",
          "--is-ancestor",
          remoteRef,
          localRef,
        ]);
      } catch {
        throw new Error(
          `refusing to push ${branch}: origin/${branch} is not an ancestor of ${head}`
        );
      }
    }

    await runGit(transportDirectory, hostEnv, [
      "push",
      "--no-verify",
      remoteUrl,
      `${localRef}:refs/heads/${branch}`,
    ]);
    const unpublishedWorktreeChanges = await readUnpublishedWorktreeChanges(
      options.cwd,
      workspaceEnv
    );
    return {
      branch,
      pushed: true,
      head,
      unpublishedWorktreeChanges,
    };
  } finally {
    await rm(transportDirectory, { recursive: true, force: true });
  }
}

export function formatUnpublishedWorktreeError(
  result: Pick<
    GitTransportResult,
    "branch" | "head" | "unpublishedWorktreeChanges"
  >
): string {
  const changes = result.unpublishedWorktreeChanges;
  if (!changes) {
    throw new Error(
      "cannot format an unpublished-worktree error without changes"
    );
  }
  return [
    "git_unpublished_worktree: committed_transport_succeeded",
    `branch=${result.branch}`,
    `head=${result.head}`,
    `tracked=[${changes.tracked.join(", ")}]`,
    `tracked_omitted=${changes.trackedOmitted}`,
    `untracked=[${changes.untracked.join(", ")}]`,
    `untracked_omitted=${changes.untrackedOmitted}`,
  ].join(" ");
}

export async function trySynchronizeAssignedBranch(options: {
  cwd: string;
  assignedBranch: string;
  remoteUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitTransportAttempt> {
  try {
    return { ok: true, result: await synchronizeAssignedBranch(options) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function shouldSynchronizeAssignedBranch(options: {
  userInputRequired: boolean;
  terminalFailure: boolean;
}): boolean {
  return !options.userInputRequired && !options.terminalFailure;
}

export function buildHostGitEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const hasBroker = Boolean(
    env.GITHUB_TOKEN_BROKER_URL && env.GITHUB_TOKEN_BROKER_SECRET
  );
  const credentialEnvironment =
    env.GITHUB_GRAPHQL_TOKEN || hasBroker
      ? createGitCredentialHelperEnvironment({
          githubToken: env.GITHUB_GRAPHQL_TOKEN,
          githubTokenBrokerUrl: env.GITHUB_TOKEN_BROKER_URL,
          githubTokenBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET,
          githubTokenCachePath: env.GITHUB_TOKEN_CACHE_PATH,
          tokenBrokerTimeoutMs: env.GITHUB_TOKEN_BROKER_TIMEOUT_MS,
          gitHost: env.GITHUB_GIT_HOST,
          gitUsername: env.GITHUB_GIT_USERNAME,
        })
      : {};
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    ...credentialEnvironment,
  };
}

function buildWorkspaceGitEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  home: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TMPDIR",
    "WINDIR",
  ]) {
    if (sourceEnv[name] !== undefined) {
      env[name] = sourceEnv[name];
    }
  }
  return env;
}

async function readCurrentBranch(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1 &&
      "stderr" in error &&
      String(error.stderr).trim() === ""
    ) {
      return null;
    }
    throw createGitError(args, error);
  }
}

async function readUnpublishedWorktreeChanges(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<GitTransportResult["unpublishedWorktreeChanges"]> {
  const output = await runGit(cwd, env, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ]);
  const tracked: string[] = [];
  const untracked: string[] = [];
  let trackedOmitted = 0;
  let untrackedOmitted = 0;
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status === "??") {
      untrackedOmitted += appendBoundedChange(untracked, path);
      continue;
    }
    if (status.includes("R") || status.includes("C")) {
      const originalPath = records[index + 1];
      trackedOmitted += appendBoundedChange(
        tracked,
        originalPath
          ? `${status} ${originalPath} -> ${path}`
          : `${status} ${path}`
      );
      index += 1;
      continue;
    }
    trackedOmitted += appendBoundedChange(tracked, `${status} ${path}`);
  }
  return tracked.length === 0 && untracked.length === 0
    ? null
    : { tracked, untracked, trackedOmitted, untrackedOmitted };
}

const MAX_UNPUBLISHED_WORKTREE_ENTRIES = 8;
const MAX_UNPUBLISHED_WORKTREE_PATH_LENGTH = 160;

function appendBoundedChange(entries: string[], change: string): 0 | 1 {
  if (entries.length >= MAX_UNPUBLISHED_WORKTREE_ENTRIES) {
    return 1;
  }
  entries.push(
    change.length > MAX_UNPUBLISHED_WORKTREE_PATH_LENGTH
      ? `${change.slice(0, MAX_UNPUBLISHED_WORKTREE_PATH_LENGTH - 1)}…`
      : change
  );
  return 0;
}

async function runGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[]
): Promise<string> {
  const safeArgs = ["-c", `core.hooksPath=${devNull}`, ...args];
  try {
    const { stdout } = await execFileAsync("git", safeArgs, {
      cwd,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw createGitError(safeArgs, error);
  }
}

function createGitError(args: string[], error: unknown): Error {
  const rawDetail =
    error && typeof error === "object" && "stderr" in error
      ? String(error.stderr).trim()
      : error instanceof Error
        ? error.message
        : String(error);
  const sensitiveUrls = args.flatMap((arg) => {
    try {
      const url = new URL(arg);
      return url.username || url.password ? [url] : [];
    } catch {
      return [];
    }
  });
  const displayArgs = args.map((arg) => redactUrlCredentials(arg));
  const detail = sensitiveUrls.reduce((value, url) => {
    let redacted = value.replaceAll(url.href, redactUrlCredentials(url.href));
    for (const credential of [url.username, url.password]) {
      if (!credential) continue;
      redacted = redacted
        .replaceAll(credential, "[REDACTED]")
        .replaceAll(decodeURIComponent(credential), "[REDACTED]");
    }
    return redacted;
  }, rawDetail);
  return new Error(`git ${displayArgs.join(" ")} failed: ${detail}`);
}

function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return value;
  }
}

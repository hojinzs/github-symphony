import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  RunAttemptPhase,
  SessionExitClassification,
} from "@gh-symphony/core";
import { createGitCredentialHelperEnvironment } from "@gh-symphony/runtime-codex";

const execFileAsync = promisify(execFile);

export type GitTransportResult = {
  branch: string;
  pushed: boolean;
  head: string;
};

export type GitTransportAttempt =
  | { ok: true; result: GitTransportResult }
  | { ok: false; error: string };

export type GitTransportLifecycleState = {
  status: "idle" | "starting" | "running" | "failed" | "completed";
  runPhase: RunAttemptPhase | null;
  lastError: string | null;
  exitClassification: SessionExitClassification | null;
};

export function applyGitTransportAttempt(
  state: GitTransportLifecycleState,
  attempt: GitTransportAttempt,
  writeStderr: (message: string) => void = (message) =>
    process.stderr.write(message)
): 0 | 1 {
  if (attempt.ok) {
    writeStderr(
      `[worker] host Git transport pushed ${attempt.result.branch} at ${attempt.result.head}\n`
    );
    return 0;
  }

  state.status = "failed";
  state.runPhase = "failed";
  state.lastError = `git_transport_failed: ${attempt.error}`;
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
    return { branch, pushed: true, head };
  } finally {
    await rm(transportDirectory, { recursive: true, force: true });
  }
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

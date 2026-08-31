import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

export async function synchronizeAssignedBranch(options: {
  cwd: string;
  assignedBranch: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitTransportResult> {
  const env = buildHostGitEnvironment(options.env ?? process.env);
  const branch = options.assignedBranch.trim();
  if (!branch) {
    throw new Error("assigned Git branch is not set");
  }
  await runGit(options.cwd, env, ["check-ref-format", "--branch", branch]);
  const currentBranch = await readCurrentBranch(options.cwd, env);
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
  const head = (await runGit(options.cwd, env, ["rev-parse", localRef])).trim();

  await runGit(options.cwd, env, ["fetch", "origin"]);
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (await gitRefExists(options.cwd, env, remoteRef)) {
    try {
      await runGit(options.cwd, env, [
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

  await runGit(options.cwd, env, [
    "push",
    "origin",
    `${localRef}:refs/heads/${branch}`,
  ]);
  return { branch, pushed: true, head };
}

export async function trySynchronizeAssignedBranch(options: {
  cwd: string;
  assignedBranch: string;
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

function buildHostGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
        })
      : {};
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    ...credentialEnvironment,
  };
}

async function gitRefExists(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ref: string
): Promise<boolean> {
  try {
    await runGit(cwd, env, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function readCurrentBranch(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  try {
    const branch = await runGit(cwd, env, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    return branch.trim() || null;
  } catch {
    return null;
  }
}

async function runGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitCredentialHelperEnvironment } from "@gh-symphony/runtime-codex";

const execFileAsync = promisify(execFile);

export type GitTransportResult = {
  branch: string;
  pushed: boolean;
  head: string;
};

export async function synchronizeAssignedBranch(_options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitTransportResult> {
  const env = buildHostGitEnvironment(_options.env ?? process.env);
  const branch = (
    await runGit(_options.cwd, env, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ])
  ).trim();
  if (!branch || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(
      `invalid assigned Git branch: ${branch || "detached HEAD"}`
    );
  }
  const head = (await runGit(_options.cwd, env, ["rev-parse", "HEAD"])).trim();

  await runGit(_options.cwd, env, ["fetch", "origin"]);
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (await gitRefExists(_options.cwd, env, remoteRef)) {
    try {
      await runGit(_options.cwd, env, [
        "merge-base",
        "--is-ancestor",
        remoteRef,
        "HEAD",
      ]);
    } catch {
      throw new Error(
        `refusing to push ${branch}: origin/${branch} is not an ancestor of ${head}`
      );
    }
  }

  await runGit(_options.cwd, env, [
    "push",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  return { branch, pushed: true, head };
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

import { join } from "node:path";

const PORTABLE_ENVIRONMENT_NAMES = [
  "COLORTERM",
  "LANG",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
] as const;

/** Non-secret worker context intentionally exposed to every agent runtime. */
export const AGENT_VISIBLE_SYMPHONY_CONTEXT_ENVIRONMENT_NAMES = [
  "SYMPHONY_ASSIGNED_BRANCH",
  "SYMPHONY_ISSUE_ID",
  "SYMPHONY_ISSUE_IDENTIFIER",
  "SYMPHONY_ISSUE_STATE",
  "SYMPHONY_TRACKER_KIND",
  "TARGET_REPOSITORY_CLONE_URL",
  "TARGET_REPOSITORY_NAME",
  "TARGET_REPOSITORY_OWNER",
  "TARGET_REPOSITORY_URL",
] as const;

export function readAgentVisibleSymphonyContext(
  ...sources: ReadonlyArray<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv {
  const context: NodeJS.ProcessEnv = {};
  // Sources are applied in order so later runtime-specific values win.
  for (const source of sources) {
    for (const name of AGENT_VISIBLE_SYMPHONY_CONTEXT_ENVIRONMENT_NAMES) {
      const value = source?.[name];
      if (value !== undefined) {
        context[name] =
          name === "TARGET_REPOSITORY_CLONE_URL"
            ? sanitizeRepositoryCloneUrl(value)
            : value;
      }
    }
  }
  return context;
}

/** Host credential plumbing that must never cross an agent-child boundary. */
export const AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES = [
  "AGENT_CREDENTIAL_BROKER_URL",
  "AGENT_CREDENTIAL_BROKER_SECRET",
  "AGENT_CREDENTIAL_CACHE_PATH",
  "GITHUB_GIT_HOST",
  "GITHUB_GIT_USERNAME",
  "GIT_ASKPASS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_VALUE_0",
  "GIT_DIR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
  "GITHUB_TOKEN_BROKER_URL",
  "GITHUB_TOKEN_CACHE_PATH",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
] as const;

export function isAgentChildCredentialEnvironmentName(name: string): boolean {
  return (
    AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES.includes(
      name as (typeof AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES)[number]
    ) ||
    name.startsWith("GIT_CONFIG_KEY_") ||
    name.startsWith("GIT_CONFIG_VALUE_")
  );
}

export function isCustomRuntimeReservedAuthEnvironmentName(
  name: string,
  environment: NodeJS.ProcessEnv,
  trackerSecretEnvironmentNames: readonly string[] = []
): boolean {
  return (
    isAgentChildCredentialEnvironmentName(name) ||
    trackerSecretEnvironmentNames.includes(name) ||
    readTrackerSecretEnvironmentNames(environment).includes(name)
  );
}

/** Builds the least-privilege environment for an operator-supplied command. */
export function buildCustomRuntimeChildEnvironment(options: {
  childHome: string;
  source?: NodeJS.ProcessEnv;
  input?: NodeJS.ProcessEnv;
  authEnvKey?: string;
  inheritEnvironment?: boolean;
}): NodeJS.ProcessEnv {
  const source = options.source ?? {};
  const input = options.input ?? {};
  const decisionSources = options.inheritEnvironment
    ? [process.env, source, input]
    : [source, input];
  const decisionEnvironment = Object.assign({}, ...decisionSources);
  const env: NodeJS.ProcessEnv = options.inheritEnvironment
    ? { ...decisionEnvironment }
    : {};

  if (!options.inheritEnvironment) {
    for (const name of PORTABLE_ENVIRONMENT_NAMES) {
      // A supplied worker environment is deliberately augmented with portable
      // process defaults so custom commands keep normal terminal behavior.
      const value = source[name] ?? process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    const authValue = options.authEnvKey
      ? (input[options.authEnvKey] ?? source[options.authEnvKey])
      : undefined;
    if (options.authEnvKey && authValue !== undefined) {
      env[options.authEnvKey] = authValue;
    }
  }

  Object.assign(env, readAgentVisibleSymphonyContext(...decisionSources));

  env.HOME = options.childHome;
  env.USERPROFILE = options.childHome;
  env.GH_CONFIG_DIR = join(options.childHome, "gh");
  for (const name of Object.keys(env)) {
    if (isCustomRuntimeReservedAuthEnvironmentName(name, decisionEnvironment)) {
      if (name === options.authEnvKey) {
        throw new Error(
          `Custom runtime auth environment variable ${name} is reserved and cannot be exposed to the child.`
        );
      }
      delete env[name];
    }
  }
  stripCredentialEnvironmentForAgentChild(env);
  return env;
}

/**
 * Removes URL userinfo before a clone URL is persisted or exposed to a child.
 * Authentication remains the responsibility of configured credential helpers.
 */
export function sanitizeRepositoryCloneUrl(cloneUrl: string): string {
  try {
    const url = new URL(cloneUrl);
    if (url.protocol === "ssh:") {
      return cloneUrl;
    }
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Git accepts URL forms that the WHATWG parser rejects. Remove only
    // leading URL userinfo; SCP-like SSH remotes remain untouched.
    return cloneUrl.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

export function stripCredentialEnvironmentForAgentChild(
  env: NodeJS.ProcessEnv
): void {
  for (const name of Object.keys(env)) {
    if (isAgentChildCredentialEnvironmentName(name)) {
      delete env[name];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
}

export function readTrackerSecretEnvironmentNames(
  env: NodeJS.ProcessEnv
): string[] {
  try {
    const names = JSON.parse(
      env.SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES ?? "[]"
    );
    return Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

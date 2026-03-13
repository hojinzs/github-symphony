import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_GITHUB_GRAPHQL_API_URL = "https://api.github.com/graphql";
const DEFAULT_GITHUB_GIT_HOST = "github.com";
const DEFAULT_GITHUB_GIT_USERNAME = "x-access-token";

export type RuntimeToolDefinition = {
  name: "github_graphql";
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
};

export type CodexRuntimeConfig = {
  tenantId: string;
  workingDirectory: string;
  githubToken?: string;
  githubTokenBrokerUrl?: string;
  githubTokenBrokerSecret?: string;
  githubTokenCachePath?: string;
  agentEnv?: Record<string, string>;
  agentCredentialBrokerUrl?: string;
  agentCredentialBrokerSecret?: string;
  agentCredentialCachePath?: string;
  githubProjectId?: string;
  githubGraphqlApiUrl?: string;
  extraEnv?: NodeJS.ProcessEnv;
  /** Shell command to launch codex app-server. Leading "bash -lc " is stripped if present, since the runtime always wraps in bash -lc. */
  agentCommand?: string;
};

export type CodexRuntimePlan = {
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  tools: [RuntimeToolDefinition];
};

export class AgentRuntimeResolutionError extends Error {}

type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export function createGitHubGraphQLToolDefinition(
  config: Pick<
    CodexRuntimeConfig,
    | "githubToken"
    | "githubTokenBrokerUrl"
    | "githubTokenBrokerSecret"
    | "githubTokenCachePath"
    | "githubProjectId"
    | "githubGraphqlApiUrl"
  >
): RuntimeToolDefinition {
  return {
    name: "github_graphql",
    description:
      "Execute GitHub GraphQL queries for the active workspace so the agent can mutate project and issue state directly.",
    command: "node",
    args: [fileURLToPath(new URL("./github-graphql-mcp-server.js", import.meta.url))],
    env: {
      GITHUB_GRAPHQL_API_URL:
        config.githubGraphqlApiUrl ?? DEFAULT_GITHUB_GRAPHQL_API_URL,
      ...(config.githubToken
        ? {
            GITHUB_GRAPHQL_TOKEN: config.githubToken,
          }
        : {}),
      ...(config.githubTokenBrokerUrl
        ? {
            GITHUB_TOKEN_BROKER_URL: config.githubTokenBrokerUrl,
          }
        : {}),
      ...(config.githubTokenBrokerSecret
        ? {
            GITHUB_TOKEN_BROKER_SECRET: config.githubTokenBrokerSecret,
          }
        : {}),
      ...(config.githubTokenCachePath
        ? {
            GITHUB_TOKEN_CACHE_PATH: config.githubTokenCachePath,
          }
        : {}),
      ...(config.githubProjectId
        ? {
            GITHUB_PROJECT_ID: config.githubProjectId,
          }
        : {}),
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GraphQL query or mutation document.",
        },
        variables: {
          type: "object",
          description: "Variables for the GraphQL document.",
        },
        operationName: {
          type: "string",
          description: "Optional GraphQL operation name.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

export function buildCodexRuntimePlan(
  config: CodexRuntimeConfig
): CodexRuntimePlan {
  const tool = createGitHubGraphQLToolDefinition(config);
  const gitCredentialHelper = createGitCredentialHelperEnvironment(config);

  const shellCmd = (() => {
    const cmd = config.agentCommand ?? "codex app-server";
    return cmd.startsWith("bash -lc ") ? cmd.slice("bash -lc ".length) : cmd;
  })();

  return {
    cwd: config.workingDirectory,
    command: "bash",
    args: ["-lc", shellCmd],
    env: {
      ...process.env,
      ...config.extraEnv,
      ...config.agentEnv,
      CODEX_TENANT_ID: config.tenantId,
      GITHUB_PROJECT_ID: config.githubProjectId ?? "",
      GITHUB_GRAPHQL_TOOL_NAME: tool.name,
      GITHUB_GRAPHQL_TOOL_COMMAND: [tool.command, ...tool.args].join(" "),
      // Point codex to an isolated config dir so personal MCPs (playwright,
      // chrome-devtools, context7, etc.) from the operator's ~/.codex/config.toml
      // are not loaded and do not confuse the implementation agent.
      CODEX_HOME: join(config.workingDirectory, ".codex-agent"),
      ...gitCredentialHelper,
      ...tool.env,
    },
    tools: [tool],
  };
}

export function launchCodexAppServer(
  plan: CodexRuntimePlan,
  spawnImpl: SpawnLike = spawn
): ChildProcess {
  return spawnImpl(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "pipe",
  });
}

export async function prepareCodexRuntimePlan(
  config: CodexRuntimeConfig,
  dependencies: {
    fetchImpl?: typeof fetch;
    writeFileImpl?: typeof writeFile;
    mkdirImpl?: typeof mkdir;
    copyFileImpl?: typeof copyFile;
  } = {}
): Promise<CodexRuntimePlan> {
  const agentEnv = await resolveAgentRuntimeEnvironment(config, dependencies);

  // Create an isolated CODEX_HOME directory with a minimal config.toml so the agent
  // does not inherit personal MCP servers from the operator's ~/.codex/config.toml.
  // We still copy auth.json so codex can authenticate without requiring OPENAI_API_KEY.
  const codexHomeDir = join(config.workingDirectory, ".codex-agent");
  const mkdirImpl = dependencies.mkdirImpl ?? mkdir;
  await mkdirImpl(codexHomeDir, { recursive: true });
  const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
  // Write a minimal config.toml with no mcp_servers block so codex only uses
  // the dynamic tool definitions passed via thread/start config.
  await writeFileImpl(
    join(codexHomeDir, "config.toml"),
    "# Isolated agent config \u2014 no personal MCP servers\n",
    "utf8"
  );
  // Copy auth.json from the real CODEX_HOME so codex can use ChatGPT OAuth tokens.
  // This is safe: auth is per-user and needed for the agent to call OpenAI APIs.
  const realCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const copyFileImpl = dependencies.copyFileImpl ?? copyFile;
  try {
    await copyFileImpl(
      join(realCodexHome, "auth.json"),
      join(codexHomeDir, "auth.json")
    );
  } catch {
    // auth.json may not exist (e.g. when OPENAI_API_KEY is used instead)
  }

  return buildCodexRuntimePlan({
    ...config,
    agentEnv,
  });
}

export function createGitCredentialHelperEnvironment(
  config: Pick<
    CodexRuntimeConfig,
    | "githubToken"
    | "githubTokenBrokerUrl"
    | "githubTokenBrokerSecret"
    | "githubTokenCachePath"
  >
): Record<string, string> {
  return {
    GITHUB_GIT_HOST: DEFAULT_GITHUB_GIT_HOST,
    GITHUB_GIT_USERNAME: DEFAULT_GITHUB_GIT_USERNAME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `!node ${fileURLToPath(
      new URL("./git-credential-helper.js", import.meta.url)
    )}`,
    ...(config.githubToken
      ? {
          GITHUB_GRAPHQL_TOKEN: config.githubToken,
        }
      : {}),
    ...(config.githubTokenBrokerUrl
      ? {
          GITHUB_TOKEN_BROKER_URL: config.githubTokenBrokerUrl,
        }
      : {}),
    ...(config.githubTokenBrokerSecret
      ? {
          GITHUB_TOKEN_BROKER_SECRET: config.githubTokenBrokerSecret,
        }
      : {}),
    ...(config.githubTokenCachePath
      ? {
          GITHUB_TOKEN_CACHE_PATH: config.githubTokenCachePath,
        }
      : {}),
  };
}

export async function resolveAgentRuntimeEnvironment(
  config: Pick<
    CodexRuntimeConfig,
    | "agentEnv"
    | "agentCredentialBrokerUrl"
    | "agentCredentialBrokerSecret"
    | "agentCredentialCachePath"
  >,
  dependencies: {
    fetchImpl?: typeof fetch;
    writeFileImpl?: typeof writeFile;
  } = {}
): Promise<Record<string, string>> {
  if (config.agentEnv) {
    return config.agentEnv;
  }

  if (!config.agentCredentialBrokerUrl || !config.agentCredentialBrokerSecret) {
    return {};
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(config.agentCredentialBrokerUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.agentCredentialBrokerSecret}`,
    },
  });
  const payload = (await response.json()) as {
    env?: Record<string, string>;
    error?: string;
  };

  if (!response.ok || !payload.env || Object.keys(payload.env).length === 0) {
    throw new AgentRuntimeResolutionError(
      payload.error ??
        `Agent credential broker request failed with status ${response.status}.`
    );
  }

  if (config.agentCredentialCachePath) {
    const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
    await writeFileImpl(
      config.agentCredentialCachePath,
      JSON.stringify(payload),
      "utf8"
    );
  }

  return payload.env;
}

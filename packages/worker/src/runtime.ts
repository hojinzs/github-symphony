import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
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
  workspaceId: string;
  workingDirectory: string;
  githubToken?: string;
  githubTokenBrokerUrl?: string;
  githubTokenBrokerSecret?: string;
  githubTokenCachePath?: string;
  githubProjectId?: string;
  githubGraphqlApiUrl?: string;
  extraEnv?: NodeJS.ProcessEnv;
};

export type CodexRuntimePlan = {
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  tools: [RuntimeToolDefinition];
};

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
    args: [fileURLToPath(new URL("./github-graphql-tool.js", import.meta.url))],
    env: {
      GITHUB_GRAPHQL_API_URL:
        config.githubGraphqlApiUrl ?? DEFAULT_GITHUB_GRAPHQL_API_URL,
      ...(config.githubToken
        ? {
            GITHUB_GRAPHQL_TOKEN: config.githubToken
          }
        : {}),
      ...(config.githubTokenBrokerUrl
        ? {
            GITHUB_TOKEN_BROKER_URL: config.githubTokenBrokerUrl
          }
        : {}),
      ...(config.githubTokenBrokerSecret
        ? {
            GITHUB_TOKEN_BROKER_SECRET: config.githubTokenBrokerSecret
          }
        : {}),
      ...(config.githubTokenCachePath
        ? {
            GITHUB_TOKEN_CACHE_PATH: config.githubTokenCachePath
          }
        : {}),
      ...(config.githubProjectId
        ? {
            GITHUB_PROJECT_ID: config.githubProjectId
          }
        : {})
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GraphQL query or mutation document."
        },
        variables: {
          type: "object",
          description: "Variables for the GraphQL document."
        },
        operationName: {
          type: "string",
          description: "Optional GraphQL operation name."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  };
}

export function buildCodexRuntimePlan(config: CodexRuntimeConfig): CodexRuntimePlan {
  const tool = createGitHubGraphQLToolDefinition(config);
  const gitCredentialHelper = createGitCredentialHelperEnvironment(config);

  return {
    cwd: config.workingDirectory,
    command: "bash",
    args: ["-lc", "codex app-server"],
    env: {
      ...process.env,
      ...config.extraEnv,
      CODEX_WORKSPACE_ID: config.workspaceId,
      GITHUB_PROJECT_ID: config.githubProjectId ?? "",
      GITHUB_GRAPHQL_TOOL_NAME: tool.name,
      GITHUB_GRAPHQL_TOOL_COMMAND: [tool.command, ...tool.args].join(" "),
      ...gitCredentialHelper,
      ...tool.env
    },
    tools: [tool]
  };
}

export function launchCodexAppServer(
  plan: CodexRuntimePlan,
  spawnImpl: SpawnLike = spawn
): ChildProcess {
  return spawnImpl(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "pipe"
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
          GITHUB_GRAPHQL_TOKEN: config.githubToken
        }
      : {}),
    ...(config.githubTokenBrokerUrl
      ? {
          GITHUB_TOKEN_BROKER_URL: config.githubTokenBrokerUrl
        }
      : {}),
    ...(config.githubTokenBrokerSecret
      ? {
          GITHUB_TOKEN_BROKER_SECRET: config.githubTokenBrokerSecret
        }
      : {}),
    ...(config.githubTokenCachePath
      ? {
          GITHUB_TOKEN_CACHE_PATH: config.githubTokenCachePath
        }
      : {})
  };
}

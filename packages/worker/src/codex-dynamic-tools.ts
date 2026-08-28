import {
  executeGitHubGraphQL,
  type GitHubGraphQLInvocation,
} from "@gh-symphony/tool-github-graphql";
import {
  executeLinearGraphQL,
  type LinearGraphQLInvocation,
} from "@gh-symphony/tool-linear-graphql";

export type TrackerToolContext = {
  issue: {
    id: string;
    identifier: string;
    nativeRef: unknown;
  };
};

export type CodexDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

type HostToolDependencies = {
  executeGitHubGraphQL?: (
    invocation: GitHubGraphQLInvocation,
    config: Parameters<typeof executeGitHubGraphQL>[1],
    context: TrackerToolContext
  ) => Promise<unknown>;
  executeLinearGraphQL?: (
    invocation: LinearGraphQLInvocation,
    config: Parameters<typeof executeLinearGraphQL>[1],
    context: TrackerToolContext
  ) => Promise<unknown>;
};

export function createTrackerToolContext(
  env: NodeJS.ProcessEnv
): TrackerToolContext {
  return {
    issue: {
      id: env.SYMPHONY_ISSUE_ID ?? "",
      identifier: env.SYMPHONY_ISSUE_IDENTIFIER ?? "",
      nativeRef: parseNativeRef(env.SYMPHONY_ISSUE_NATIVE_REF),
    },
  };
}

export async function executeCodexDynamicToolCall(
  toolName: string,
  argumentsValue: unknown,
  context: TrackerToolContext,
  env: NodeJS.ProcessEnv,
  dependencies: HostToolDependencies = {},
  allowedToolNames: readonly string[] = ["github_graphql", "linear_graphql"]
): Promise<CodexDynamicToolCallResponse> {
  if (!isRecord(argumentsValue)) {
    return failure("invalid_arguments", "Tool arguments must be an object.");
  }

  try {
    let result: unknown;
    if (!allowedToolNames.includes(toolName)) {
      return failure("unknown_tool", `Tool \"${toolName}\" is not supported.`);
    }
    switch (toolName) {
      case "github_graphql":
        result = dependencies.executeGitHubGraphQL
          ? await dependencies.executeGitHubGraphQL(
              argumentsValue as GitHubGraphQLInvocation,
              githubConfig(env),
              context
            )
          : await executeGitHubGraphQL(
              argumentsValue as GitHubGraphQLInvocation,
              githubConfig(env)
            );
        break;
      case "linear_graphql":
        result = dependencies.executeLinearGraphQL
          ? await dependencies.executeLinearGraphQL(
              argumentsValue as LinearGraphQLInvocation,
              linearConfig(env),
              context
            )
          : await executeLinearGraphQL(
              argumentsValue as LinearGraphQLInvocation,
              linearConfig(env)
            );
        break;
      default:
        return failure("unknown_tool", `Tool \"${toolName}\" is not supported.`);
    }

    // Keep the context at this host-only boundary. It is intentionally not
    // serialized into the child-visible result.
    void context;
    return success(result);
  } catch (error) {
    return failure(
      "tool_execution_failed",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function githubConfig(
  env: NodeJS.ProcessEnv
): Parameters<typeof executeGitHubGraphQL>[1] {
  return {
    token: env.GITHUB_GRAPHQL_TOKEN,
    apiUrl: env.GITHUB_GRAPHQL_API_URL,
    tokenBrokerUrl: env.GITHUB_TOKEN_BROKER_URL,
    tokenBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET,
    tokenCachePath: env.GITHUB_TOKEN_CACHE_PATH,
  };
}

function linearConfig(
  env: NodeJS.ProcessEnv
): Parameters<typeof executeLinearGraphQL>[1] {
  return {
    apiKey: env.LINEAR_API_KEY,
    apiUrl: env.LINEAR_GRAPHQL_URL,
    authorizationHeader: env.LINEAR_AUTHORIZATION,
  };
}

function parseNativeRef(value: string | undefined): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function success(result: unknown): CodexDynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  };
}

function failure(code: string, message: string): CodexDynamicToolCallResponse {
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
  };
}

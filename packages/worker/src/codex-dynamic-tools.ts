import {
  executeGitHubGraphQL,
  type GitHubGraphQLInvocation,
  type TrackerToolExecutionContext as GitHubTrackerToolExecutionContext,
} from "@gh-symphony/tool-github-graphql";
import {
  executeLinearGraphQL,
  type LinearGraphQLInvocation,
  type TrackerToolExecutionContext as LinearTrackerToolExecutionContext,
} from "@gh-symphony/tool-linear-graphql";

export type TrackerToolContext = GitHubTrackerToolExecutionContext &
  LinearTrackerToolExecutionContext;

export type CodexDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

type HostToolDependencies = {
  executeGitHubGraphQL?: typeof executeGitHubGraphQL;
  executeLinearGraphQL?: typeof executeLinearGraphQL;
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
  if (!allowedToolNames.includes(toolName)) {
    return failure("unknown_tool", `Tool "${toolName}" is not supported.`);
  }

  try {
    let result: unknown;
    switch (toolName) {
      case "github_graphql": {
        const execute = dependencies.executeGitHubGraphQL ?? executeGitHubGraphQL;
        result = await execute(
          argumentsValue as GitHubGraphQLInvocation,
          githubConfig(env),
          fetch,
          context
        );
        break;
      }
      case "linear_graphql": {
        const execute = dependencies.executeLinearGraphQL ?? executeLinearGraphQL;
        result = await execute(
          argumentsValue as LinearGraphQLInvocation,
          linearConfig(env),
          fetch,
          context
        );
        break;
      }
      default:
        // The allowlist is snapshotted at session startup. Retain a defensive
        // response in case a future advertised name lacks an adapter handler.
        return failure("unknown_tool", `Tool "${toolName}" is not supported.`);
    }

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

import { resolveGitHubGraphQLMcpServerEntryPoint } from "./mcp-server.js";
import {
  validateGitHubGraphQLApiUrl,
  validateGitHubTokenBrokerUrl,
} from "./url-policy.js";

export const DEFAULT_GITHUB_GRAPHQL_API_URL = "https://api.github.com/graphql";

export type GitHubGraphQLMcpServerEntryOptions = {
  githubToken?: string;
  githubTokenBrokerUrl?: string;
  githubTokenBrokerSecret?: string;
  githubTokenCachePath?: string;
  githubProjectId?: string;
  githubGraphqlApiUrl?: string;
};

export type GitHubGraphQLMcpServerEntry = {
  command: "node";
  args: string[];
  env: Record<string, string>;
};

export function createGitHubGraphQLMcpServerEntry(
  options: GitHubGraphQLMcpServerEntryOptions = {}
): GitHubGraphQLMcpServerEntry {
  const githubGraphqlApiUrl = validateGitHubGraphQLApiUrl(
    options.githubGraphqlApiUrl ?? DEFAULT_GITHUB_GRAPHQL_API_URL
  );
  const githubTokenBrokerUrl = options.githubTokenBrokerUrl
    ? validateGitHubTokenBrokerUrl(options.githubTokenBrokerUrl)
    : undefined;

  return {
    command: "node",
    args: [resolveGitHubGraphQLMcpServerEntryPoint()],
    env: {
      GITHUB_GRAPHQL_API_URL: githubGraphqlApiUrl,
      ...(options.githubToken
        ? {
            GITHUB_GRAPHQL_TOKEN: options.githubToken,
          }
        : {}),
      ...(githubTokenBrokerUrl
        ? {
            GITHUB_TOKEN_BROKER_URL: githubTokenBrokerUrl,
          }
        : {}),
      ...(options.githubTokenBrokerSecret
        ? {
            GITHUB_TOKEN_BROKER_SECRET: options.githubTokenBrokerSecret,
          }
        : {}),
      ...(options.githubTokenCachePath
        ? {
            GITHUB_TOKEN_CACHE_PATH: options.githubTokenCachePath,
          }
        : {}),
      ...(options.githubProjectId
        ? {
            GITHUB_PROJECT_ID: options.githubProjectId,
          }
        : {}),
    },
  };
}

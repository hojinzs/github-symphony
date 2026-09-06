import { resolveGitHubGraphQLMcpServerEntryPoint } from "./mcp-server.js";
import { validateGitHubGraphQLApiUrl } from "./url-policy.js";

export const DEFAULT_GITHUB_GRAPHQL_API_URL = "https://api.github.com/graphql";

export type GitHubGraphQLMcpServerEntryOptions = {
  githubToken?: string;
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
  return {
    command: "node",
    args: [resolveGitHubGraphQLMcpServerEntryPoint(), "--server", "github"],
    env: {
      GITHUB_GRAPHQL_API_URL: githubGraphqlApiUrl,
      ...(options.githubToken
        ? {
            GITHUB_GRAPHQL_TOKEN: options.githubToken,
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

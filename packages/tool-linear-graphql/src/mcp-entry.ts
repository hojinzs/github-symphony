import { resolveLinearGraphQLMcpServerEntryPoint } from "./mcp-server.js";
import { DEFAULT_LINEAR_GRAPHQL_API_URL } from "./tool.js";
import { validateLinearGraphQLApiUrl } from "./url-policy.js";

export type LinearGraphQLMcpServerEntryOptions = {
  linearGraphqlUrl?: string;
  linearAuthorization?: string;
  linearApiKey?: string;
};

export type LinearGraphQLMcpServerEntry = {
  command: "node";
  args: string[];
  env: Record<string, string>;
};

export function createLinearGraphQLMcpServerEntry(
  options: LinearGraphQLMcpServerEntryOptions = {}
): LinearGraphQLMcpServerEntry {
  const linearGraphqlUrl = validateLinearGraphQLApiUrl(
    options.linearGraphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_API_URL
  );

  return {
    command: "node",
    args: [resolveLinearGraphQLMcpServerEntryPoint(), "--server", "linear"],
    env: {
      LINEAR_GRAPHQL_URL: linearGraphqlUrl,
      ...(options.linearAuthorization
        ? { LINEAR_AUTHORIZATION: options.linearAuthorization }
        : {}),
      ...(options.linearApiKey ? { LINEAR_API_KEY: options.linearApiKey } : {}),
    },
  };
}

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
  const linearAuthorization = options.linearAuthorization?.trim();
  const linearApiKey = options.linearApiKey?.trim();

  return {
    command: "node",
    args: [resolveLinearGraphQLMcpServerEntryPoint(), "--server", "linear"],
    env: {
      LINEAR_GRAPHQL_URL: linearGraphqlUrl,
      ...(linearAuthorization
        ? { LINEAR_AUTHORIZATION: linearAuthorization }
        : {}),
      ...(linearApiKey ? { LINEAR_API_KEY: linearApiKey } : {}),
    },
  };
}

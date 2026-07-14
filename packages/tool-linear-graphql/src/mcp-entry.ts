import { resolveLinearGraphQLMcpServerEntryPoint } from "./mcp-server.js";
import { DEFAULT_LINEAR_GRAPHQL_API_URL } from "./tool.js";
import { validateLinearGraphQLApiUrl } from "./url-policy.js";

export type LinearGraphQLMcpServerEntryOptions = {
  linearGraphqlUrl?: string;
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
    args: [resolveLinearGraphQLMcpServerEntryPoint()],
    env: {
      LINEAR_GRAPHQL_URL: linearGraphqlUrl,
    },
  };
}

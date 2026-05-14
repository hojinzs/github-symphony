import { resolveLinearGraphQLMcpServerEntryPoint } from "./mcp-server.js";
import { DEFAULT_LINEAR_GRAPHQL_API_URL } from "./tool.js";

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
  return {
    command: "node",
    args: [resolveLinearGraphQLMcpServerEntryPoint()],
    env: {
      LINEAR_GRAPHQL_URL:
        options.linearGraphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_API_URL,
    },
  };
}

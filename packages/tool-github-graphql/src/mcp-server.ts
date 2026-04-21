import { fileURLToPath } from "node:url";

/**
 * MCP server wrapper for the github_graphql tool.
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0 over stdio) so that
 * runtimes can register this as an mcp_server and call the github_graphql tool
 * natively.
 *
 * MCP protocol flow:
 *   client → initialize → server responds with {protocolVersion, capabilities, serverInfo}
 *   client → tools/list  → server responds with list of tools
 *   client → tools/call  → server calls github-graphql-tool, returns result
 */

import {
  executeGitHubGraphQL,
  type GitHubGraphQLInvocation,
} from "./tool.js";

const TOOL_SCHEMA = {
  name: "github_graphql",
  description:
    "Execute GitHub GraphQL queries for the active workspace so the agent can mutate project and issue state directly.",
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

let lineBuffer = "";

export function resolveGitHubGraphQLMcpServerEntryPoint(): string {
  return fileURLToPath(new URL("./mcp-server.js", import.meta.url));
}

function sendResponse(id: string | number | null, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(
  id: string | number | null,
  code: number,
  message: string
): void {
  const msg = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  process.stdout.write(msg + "\n");
}

async function handleRequest(msg: {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}): Promise<void> {
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "github-symphony-graphql",
          version: "0.1.0",
        },
      });
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n"
      );
      break;
    }

    case "tools/list": {
      sendResponse(id, { tools: [TOOL_SCHEMA] });
      break;
    }

    case "tools/call": {
      const params = msg.params as {
        name: string;
        arguments?: Record<string, unknown>;
      };

      if (params.name !== "github_graphql") {
        sendError(id, -32602, `Unknown tool: ${params.name}`);
        return;
      }

      const args = params.arguments ?? {};
      const invocation: GitHubGraphQLInvocation = {
        query: args.query as string,
        variables: args.variables as Record<string, unknown> | undefined,
        operationName: args.operationName as string | undefined,
      };

      try {
        const result = await executeGitHubGraphQL(invocation, {
          token: process.env.GITHUB_GRAPHQL_TOKEN,
          apiUrl: process.env.GITHUB_GRAPHQL_API_URL,
          tokenBrokerUrl: process.env.GITHUB_TOKEN_BROKER_URL,
          tokenBrokerSecret: process.env.GITHUB_TOKEN_BROKER_SECRET,
          tokenCachePath: process.env.GITHUB_TOKEN_CACHE_PATH,
        });

        sendResponse(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendResponse(id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
      break;
    }

    case "notifications/initialized":
    case "ping": {
      if (id !== null && id !== undefined) {
        sendResponse(id, {});
      }
      break;
    }

    default: {
      if (id !== null && id !== undefined) {
        sendError(id, -32601, `Method not found: ${msg.method}`);
      }
    }
  }
}

async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk: string) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as {
          jsonrpc: string;
          id?: string | number | null;
          method: string;
          params?: unknown;
        };
        void handleRequest(msg);
      } catch (err) {
        process.stderr.write(
          `[github-graphql-mcp] parse error: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[github-graphql-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  });
}

import { fileURLToPath } from "node:url";
import { executeLinearGraphQL, type LinearGraphQLInvocation } from "./tool.js";

const TOOL_SCHEMA = {
  name: "linear_graphql",
  description:
    "Execute a single Linear GraphQL query or mutation for the active Linear issue using runtime-managed auth.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Single GraphQL query or mutation document.",
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

export function resolveLinearGraphQLMcpServerEntryPoint(): string {
  return fileURLToPath(new URL("./mcp-server.js", import.meta.url));
}

function sendResponse(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(
  id: string | number | null,
  code: number,
  message: string
): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`
  );
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
          name: "github-symphony-linear-graphql",
          version: "0.1.0",
        },
      });
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        })}\n`
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

      if (params.name !== "linear_graphql") {
        sendError(id, -32602, `Unknown tool: ${params.name}`);
        return;
      }

      const args = params.arguments ?? {};
      const invocation: LinearGraphQLInvocation = {
        query: args.query as string,
        variables: args.variables as Record<string, unknown> | undefined,
        operationName: args.operationName as string | undefined,
      };

      try {
        const result = await executeLinearGraphQL(invocation, {
          apiKey: process.env.LINEAR_API_KEY,
          apiUrl: process.env.LINEAR_GRAPHQL_URL,
          authorizationHeader: process.env.LINEAR_AUTHORIZATION,
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
          `[linear-graphql-mcp] parse error: ${err instanceof Error ? err.message : String(err)}\n`
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
      `[linear-graphql-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  });
}

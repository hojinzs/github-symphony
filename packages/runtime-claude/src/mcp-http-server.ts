import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AgentToolExecutionContext,
  OrchestratorTrackerAdapter,
} from "@gh-symphony/core";
import { githubProjectTrackerAdapter } from "@gh-symphony/tracker-github";
import { linearTrackerAdapter } from "@gh-symphony/tracker-linear";

export type ClaudeMcpHostContext = AgentToolExecutionContext;
export type ClaudeMcpHttpServer = {
  url: string;
  sessionToken: string;
  close(): Promise<void>;
};

/** A worker-owned, loopback-only Streamable HTTP MCP endpoint. */
export async function startClaudeMcpHttpServer(options: {
  env: NodeJS.ProcessEnv;
  context: ClaudeMcpHostContext;
  onEvent?: (event: "started" | "stopped") => void;
}): Promise<ClaudeMcpHttpServer> {
  const sessionToken = randomBytes(32).toString("base64url");
  let server: Server | null = createServer(async (request, response) => {
    if (!isAuthorized(request, sessionToken)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(request.method === "GET" ? 405 : 404).end();
      return;
    }
    const payload = await readJson(request);
    if (!isRecord(payload)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify(error(null, -32700, "Parse error")));
      return;
    }
    const result = await dispatch(payload, options.env, options.context);
    if (!("id" in payload)) {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  options.onEvent?.("started");
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    sessionToken,
    async close(): Promise<void> {
      if (!server) return;
      const closing = server;
      server = null;
      closing.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        closing.close((error) => (error ? reject(error) : resolve()))
      );
      options.onEvent?.("stopped");
    },
  };
}

async function dispatch(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  context: ClaudeMcpHostContext
): Promise<Record<string, unknown>> {
  const id = payload.id ?? null;
  if (payload.method === "initialize")
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "github-symphony", version: "1" },
      },
    };
  if (payload.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (payload.method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: availableTools(env) } };
  if (payload.method !== "tools/call" || !isRecord(payload.params))
    return error(id, -32601, "Method not found");
  const name = payload.params.name;
  const argumentsValue = payload.params.arguments;
  if (!isRecord(argumentsValue) || typeof name !== "string")
    return error(id, -32602, "Tool arguments must be an object.");
  const adapter = resolveHostToolAdapters(env).find((candidate) =>
    candidate.agentToolSpecs?.().some((tool) => tool.name === name)
  );
  if (!adapter?.executeAgentTool) {
    return error(id, -32602, `Tool "${name}" is not available.`);
  }
  try {
    const result = await adapter.executeAgentTool(name, argumentsValue, {
      ...context,
      environment: env,
    });
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    };
  } catch (cause) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          },
        ],
      },
    };
  }
}

function availableTools(
  env: NodeJS.ProcessEnv
): Array<Record<string, unknown>> {
  return resolveHostToolAdapters(env).flatMap(
    (adapter) => adapter.agentToolSpecs?.() ?? []
  );
}

function resolveHostToolAdapters(
  env: NodeJS.ProcessEnv
): readonly OrchestratorTrackerAdapter[] {
  return env.SYMPHONY_TRACKER_KIND === "linear"
    ? [githubProjectTrackerAdapter, linearTrackerAdapter]
    : [githubProjectTrackerAdapter];
}
function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
function error(
  id: unknown,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

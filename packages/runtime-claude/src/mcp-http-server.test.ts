import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startClaudeMcpHttpServer,
  type ClaudeMcpHttpServer,
} from "./mcp-http-server.js";

let server: ClaudeMcpHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  vi.unstubAllGlobals();
});

describe("Claude host MCP HTTP server", () => {
  it("freezes the advertised tool specs when the server starts", async () => {
    let specs = [
      {
        name: "snapshotted_tool",
        description: "Initial tool",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ];
    const adapter = {
      agentToolSpecs: () => specs,
      executeAgentTool: vi.fn(),
    };
    server = await startClaudeMcpHttpServer({
      env: {},
      context: {
        issue: { id: "issue-1", identifier: "owner/repo#1", nativeRef: {} },
      },
      adapters: [adapter],
    });
    specs = [
      {
        ...specs[0]!,
        name: "reloaded_tool",
        description: "Reloaded tool",
      },
    ];

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: [expect.objectContaining({ name: "snapshotted_tool" })],
      },
    });
  });

  it("requires its session capability and exposes only the selected host tool", async () => {
    server = await startClaudeMcpHttpServer({
      env: { SYMPHONY_TRACKER_KIND: "github" },
      context: {
        issue: { id: "issue-1", identifier: "owner/repo#1", nativeRef: {} },
      },
    });

    const unauthorized = await fetch(server.url);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { tools: [expect.objectContaining({ name: "github_graphql" })] },
    });
  });

  it("uses Streamable HTTP semantics and keeps GitHub available for Linear", async () => {
    server = await startClaudeMcpHttpServer({
      env: { SYMPHONY_TRACKER_KIND: "linear" },
      context: {
        issue: { id: "issue-1", identifier: "owner/repo#1", nativeRef: {} },
      },
    });
    const headers = {
      authorization: `Bearer ${server.sessionToken}`,
      "content-type": "application/json",
    };
    const initialize = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(initialize.status).toBe(200);
    const notification = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(notification.status).toBe(202);
    const tools = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    await expect(tools.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "github_graphql" }),
          expect.objectContaining({ name: "linear_graphql" }),
        ]),
      },
    });
    expect((await fetch(server.url, { headers })).status).toBe(405);
  });

  it("uses adapter-owned schemas and execution with the resolved host env", async () => {
    const nativeFetch = globalThis.fetch;
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { addComment: { id: "comment-1" } } }),
        {
          status: 200,
        }
      )
    );
    vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) =>
      String(url) === "https://github.test/graphql"
        ? fetchImpl(url, init)
        : nativeFetch(url, init)
    );
    server = await startClaudeMcpHttpServer({
      env: {
        GITHUB_GRAPHQL_TOKEN: "dotenv-token",
        GITHUB_GRAPHQL_API_URL: "https://github.test/graphql",
      },
      context: {
        issue: { id: "issue-1", identifier: "owner/repo#1", nativeRef: {} },
      },
    });
    const headers = {
      authorization: `Bearer ${server.sessionToken}`,
      "content-type": "application/json",
    };
    const tools = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await expect(tools.json()).resolves.toMatchObject({
      result: {
        tools: [
          expect.objectContaining({
            name: "github_graphql",
            inputSchema: expect.objectContaining({
              additionalProperties: false,
            }),
          }),
        ],
      },
    });
    const call = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "github_graphql",
          arguments: {
            query:
              "mutation($subjectId: ID!, $body: String!) { addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId } }",
            variables: { subjectId: "issue-1", body: "host-side comment" },
          },
        },
      }),
    });
    await expect(call.json()).resolves.toMatchObject({
      result: {
        content: [
          expect.objectContaining({
            text: expect.stringContaining("comment-1"),
          }),
        ],
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://github.test/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer dotenv-token",
        }),
      })
    );
  });
});

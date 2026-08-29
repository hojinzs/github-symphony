import { afterEach, describe, expect, it } from "vitest";
import {
  startClaudeMcpHttpServer,
  type ClaudeMcpHttpServer,
} from "./mcp-http-server.js";

let server: ClaudeMcpHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("Claude host MCP HTTP server", () => {
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
});

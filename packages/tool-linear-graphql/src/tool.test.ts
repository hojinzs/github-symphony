import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LINEAR_GRAPHQL_API_URL,
  createLinearGraphQLMcpServerEntry,
  executeLinearGraphQL,
  resolveLinearAuthorizationHeader,
  validateLinearGraphQLInvocation,
} from "./index.js";

describe("validateLinearGraphQLInvocation", () => {
  it("accepts a single query operation", () => {
    expect(() =>
      validateLinearGraphQLInvocation({
        query: "query Issue($id: String!) { issue(id: $id) { id identifier } }",
        variables: { id: "issue-1" },
        operationName: "Issue",
      })
    ).not.toThrow();
  });

  it("accepts a single mutation for status transitions", () => {
    expect(() =>
      validateLinearGraphQLInvocation({
        query:
          "mutation TransitionIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id } } }",
      })
    ).not.toThrow();
  });

  it("accepts a single mutation for workpad and PR-link comments", () => {
    expect(() =>
      validateLinearGraphQLInvocation({
        query:
          "mutation WriteComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }",
      })
    ).not.toThrow();
  });

  it("rejects multi-operation documents using the GraphQL AST", () => {
    expect(() =>
      validateLinearGraphQLInvocation({
        query: "query Q1 { viewer { id } } query Q2 { viewer { name } }",
      })
    ).toThrow(/exactly one GraphQL operation/);
  });
});

describe("executeLinearGraphQL", () => {
  it("posts a single operation with runtime-managed Authorization", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
      );

    await expect(
      executeLinearGraphQL(
        {
          query:
            "mutation LinkPr($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
          variables: {
            issueId: "issue-1",
            body: "PR: https://github.com/acme/repo/pull/1",
          },
          operationName: "LinkPr",
        },
        {
          authorizationHeader: "Bearer runtime-linear-token",
          apiUrl: "https://linear.example/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ data: { ok: true } });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://linear.example/graphql",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer runtime-linear-token",
        },
      })
    );
  });

  it("rejects multi-operation documents before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      executeLinearGraphQL(
        {
          query: "query Q1 { viewer { id } } query Q2 { viewer { name } }",
        },
        {
          apiKey: "lin_api_key",
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/exactly one GraphQL operation/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("resolveLinearAuthorizationHeader", () => {
  it("prefers the runtime-provided Authorization header", () => {
    expect(
      resolveLinearAuthorizationHeader({
        authorizationHeader: "Bearer brokered-token",
        apiKey: "fallback-token",
      })
    ).toBe("Bearer brokered-token");
  });

  it("supports LINEAR_API_KEY fallback", () => {
    expect(resolveLinearAuthorizationHeader({ apiKey: "lin_api_key" })).toBe(
      "Bearer lin_api_key"
    );
  });
});

describe("createLinearGraphQLMcpServerEntry", () => {
  it("creates a default MCP server entry without optional auth env", () => {
    expect(createLinearGraphQLMcpServerEntry()).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js")],
      env: {
        LINEAR_GRAPHQL_URL: DEFAULT_LINEAR_GRAPHQL_API_URL,
      },
    });
  });

  it("keeps auth out of the MCP server entry environment", () => {
    expect(
      createLinearGraphQLMcpServerEntry({
        linearGraphqlUrl: "https://linear.example/graphql",
      })
    ).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js")],
      env: {
        LINEAR_GRAPHQL_URL: "https://linear.example/graphql",
      },
    });
  });
});

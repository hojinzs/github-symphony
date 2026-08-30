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

  it("rejects fragment-only documents before HTTP", () => {
    expect(() =>
      validateLinearGraphQLInvocation({
        query: "fragment IssueFields on Issue { id identifier }",
      })
    ).toThrow(/exactly one GraphQL operation/);
  });
});

describe("executeLinearGraphQL", () => {
  it("executes a workspace query while carrying host-side issue context", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } }), {
        status: 200,
      })
    );

    await expect(
      executeLinearGraphQL(
        { query: "query Viewer { viewer { id } }" },
        { apiKey: "lin_api_key" },
        fetchImpl as typeof fetch,
        {
          issue: {
            id: "issue-1",
            identifier: "ENG-1",
            nativeRef: { itemId: "issue-1", projectSlug: "project-a" },
          },
        }
      )
    ).resolves.toEqual({ data: { viewer: { id: "user-1" } } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

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
          apiUrl: "https://api.linear.app/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ data: { ok: true } });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
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

  it("rejects fragment-only documents before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      executeLinearGraphQL(
        {
          query: "fragment IssueFields on Issue { id identifier }",
        },
        {
          apiKey: "lin_api_key",
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/exactly one GraphQL operation/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-https Linear GraphQL URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      executeLinearGraphQL(
        {
          query: "query Viewer { viewer { id } }",
        },
        {
          apiKey: "lin_api_key",
          apiUrl: "http://api.linear.app/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/must use https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects private Linear GraphQL URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      executeLinearGraphQL(
        {
          query: "query Viewer { viewer { id } }",
        },
        {
          apiKey: "lin_api_key",
          apiUrl: "https://10.0.0.2/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/private networks/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects trailing-dot localhost Linear GraphQL URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      executeLinearGraphQL(
        {
          query: "query Viewer { viewer { id } }",
        },
        {
          apiKey: "lin_api_key",
          apiUrl: "https://localhost./graphql",
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/private networks/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects IPv4-mapped private Linear GraphQL URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      executeLinearGraphQL(
        {
          query: "query Viewer { viewer { id } }",
        },
        {
          apiKey: "lin_api_key",
          apiUrl: "https://[::ffff:127.0.0.1]/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/private networks/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted Linear GraphQL URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      executeLinearGraphQL(
        {
          query: "query Viewer { viewer { id } }",
        },
        {
          apiKey: "lin_api_key",
          apiUrl: "https://linear.example/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/host is not allowlisted/);
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
      "lin_api_key"
    );
  });

  it("normalizes raw credential values and fails closed when blank", () => {
    expect(
      resolveLinearAuthorizationHeader({
        authorizationHeader: " Bearer runtime-token ",
        apiKey: " lin_api_key ",
      })
    ).toBe("Bearer runtime-token");
    expect(
      resolveLinearAuthorizationHeader({ apiKey: " lin_api_key \n" })
    ).toBe("lin_api_key");
    expect(() =>
      resolveLinearAuthorizationHeader({
        authorizationHeader: "  ",
        apiKey: "\n",
      })
    ).toThrow("Linear GraphQL auth is not configured");
  });
});

describe("createLinearGraphQLMcpServerEntry", () => {
  it("creates a default MCP server entry without optional auth env", () => {
    expect(createLinearGraphQLMcpServerEntry()).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js"), "--server", "linear"],
      env: {
        LINEAR_GRAPHQL_URL: DEFAULT_LINEAR_GRAPHQL_API_URL,
      },
    });
  });

  it("passes resolved auth through the MCP server entry environment", () => {
    expect(
      createLinearGraphQLMcpServerEntry({
        linearGraphqlUrl: "https://api.linear.app/graphql",
        linearAuthorization: "Bearer runtime-token",
        linearApiKey: "lin_api_key",
      })
    ).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js"), "--server", "linear"],
      env: {
        LINEAR_GRAPHQL_URL: "https://api.linear.app/graphql",
        LINEAR_AUTHORIZATION: "Bearer runtime-token",
        LINEAR_API_KEY: "lin_api_key",
      },
    });
  });

  it("normalizes credentials and omits whitespace-only values", () => {
    expect(
      createLinearGraphQLMcpServerEntry({
        linearAuthorization: " Bearer runtime-token ",
        linearApiKey: " \n ",
      }).env
    ).toMatchObject({
      LINEAR_AUTHORIZATION: "Bearer runtime-token",
    });
    expect(
      createLinearGraphQLMcpServerEntry({
        linearAuthorization: " \n ",
        linearApiKey: " \t ",
      }).env
    ).not.toHaveProperty("LINEAR_AUTHORIZATION");
  });
});

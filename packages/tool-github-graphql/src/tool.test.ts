import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GITHUB_GRAPHQL_API_URL,
  createGitHubGraphQLMcpServerEntry,
} from "./mcp-entry.js";
import {
  GitHubGraphQLRateLimitPolicy,
  fingerprintGitHubToken,
  githubGraphQLRateLimitPolicy,
} from "./github-rate-limit.js";
import { executeGitHubGraphQL, resolveGitHubGraphQLToken } from "./tool.js";

describe("resolveGitHubGraphQLToken", () => {
  it("returns the declared direct host token", () => {
    expect(resolveGitHubGraphQLToken({ token: " ghs_static " })).toBe(
      "ghs_static"
    );
  });

  it("rejects missing direct host authentication", () => {
    expect(() => resolveGitHubGraphQLToken({})).toThrow(
      "GITHUB_GRAPHQL_TOKEN is required."
    );
  });
});

describe("executeGitHubGraphQL", () => {
  it("executes a repository query while carrying host-side issue context", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { login: "octo" } } }), {
        status: 200,
      })
    );

    await expect(
      executeGitHubGraphQL(
        { query: "query Viewer { viewer { login } }" },
        { token: "ghs_static" },
        fetchImpl as typeof fetch,
        {
          issue: {
            id: "issue-1",
            identifier: "owner/repo#1",
            nativeRef: {
              itemId: "project-item-1",
              contentType: "Issue",
              sourceState: "OPEN",
              linkedPullRequests: [],
              linkedPullRequestsTruncated: false,
            },
          },
        }
      )
    ).resolves.toEqual({ data: { viewer: { login: "octo" } } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]![1]!.body)
    ) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["query"]);
  });

  afterEach(() => {
    githubGraphQLRateLimitPolicy.reset();
  });

  it("posts to the public GitHub GraphQL API host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { login: "octo" } } }), {
        status: 200,
      })
    );

    await expect(
      executeGitHubGraphQL(
        {
          query: "query Viewer { viewer { login } }",
        },
        {
          token: "ghs_static",
          apiUrl: "https://api.github.com/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ data: { viewer: { login: "octo" } } });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("instruments query cost and returns shared rate-limit metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            viewer: { login: "octo" },
            __ghSymphonyRateLimit: {
              cost: 7,
              remaining: 4_992,
              resetAt: "2026-08-03T01:00:00.000Z",
            },
          },
        }),
        {
          status: 200,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4992",
            "x-ratelimit-used": "8",
            "x-ratelimit-reset": "1785718800",
            "x-ratelimit-resource": "graphql",
          },
        }
      )
    );

    const result = await executeGitHubGraphQL(
      {
        query: "query Viewer { viewer { login } }",
      },
      {
        token: "ghs_static",
      },
      fetchImpl as typeof fetch
    );

    expect(result).toMatchObject({
      rateLimits: {
        source: "github",
        cost: 7,
        remaining: 4_992,
        fieldRateLimits: {
          cost: 7,
          remaining: 4_992,
        },
        headerRateLimits: {
          limit: 5_000,
          used: 8,
          resource: "graphql",
        },
      },
    });

    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string };
    expect(body.query).toContain("rateLimit");
    expect(body.query).toContain("cost");
    expect(body.query).toContain("remaining");
    expect(body.query).toContain("resetAt");
  });

  it("uses a collision-free alias when the caller aliases another root field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            rateLimit: { login: "octo" },
            __ghSymphonyRateLimit: {
              cost: 3,
              remaining: 4_997,
              resetAt: "2026-08-03T01:00:00.000Z",
            },
          },
        }),
        { status: 200 }
      )
    );

    const result = await executeGitHubGraphQL(
      {
        query: "query Viewer { rateLimit: viewer { login } }",
      },
      { token: "ghs_static" },
      fetchImpl as typeof fetch
    );

    expect(result).toMatchObject({
      rateLimits: { cost: 3, remaining: 4_997 },
    });
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string };
    expect(body.query).toContain("__ghSymphonyRateLimit: rateLimit");
  });

  it("extracts rate-limit metadata through an existing response alias", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            rl: {
              cost: 5,
              remaining: 4_995,
              resetAt: "2026-08-03T01:00:00.000Z",
            },
          },
        }),
        { status: 200 }
      )
    );

    await expect(
      executeGitHubGraphQL(
        {
          query: "query Viewer { rl: rateLimit { cost remaining resetAt } }",
        },
        { token: "ghs_static" },
        fetchImpl as typeof fetch
      )
    ).resolves.toMatchObject({
      rateLimits: { cost: 5, remaining: 4_995 },
    });
  });

  it("blocks a request when the shared cached budget is exhausted", async () => {
    const policy = new GitHubGraphQLRateLimitPolicy({
      now: () => Date.parse("2026-08-03T00:00:00.000Z"),
    });
    policy.set(fingerprintGitHubToken("ghs_static"), {
      source: "github",
      remaining: 0,
      resetAt: "2026-08-03T02:00:00.000Z",
    });
    const fetchImpl = vi.fn();

    await expect(
      executeGitHubGraphQL(
        { query: "query Viewer { viewer { login } }" },
        {
          token: "ghs_static",
          rateLimitPolicy: policy,
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toMatchObject({
      name: "GitHubGraphQLRateLimitError",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries secondary rate limits with the shared bounded policy", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const policy = new GitHubGraphQLRateLimitPolicy({
      retryAttempts: 2,
      retryBaseMs: 0,
      sleep,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "secondary rate limit" }), {
          status: 429,
          headers: { "retry-after": "0" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              viewer: { login: "octo" },
              __ghSymphonyRateLimit: {
                cost: 1,
                remaining: 4_999,
                resetAt: "2026-08-03T01:00:00.000Z",
              },
            },
          }),
          { status: 200 }
        )
      );

    await expect(
      executeGitHubGraphQL(
        { query: "query Viewer { viewer { login } }" },
        { token: "ghs_static", rateLimitPolicy: policy },
        fetchImpl as typeof fetch
      )
    ).resolves.toMatchObject({
      rateLimits: { cost: 1, remaining: 4_999 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("supports a configured public GHES GraphQL API URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { login: "octo" } } }), {
        status: 200,
      })
    );

    await expect(
      executeGitHubGraphQL(
        {
          query: "query Viewer { viewer { login } }",
        },
        {
          token: "ghs_static",
          apiUrl: "https://github.example/api/graphql",
        },
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ data: { viewer: { login: "octo" } } });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://github.example/api/graphql",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("createGitHubGraphQLMcpServerEntry", () => {
  it("creates a default MCP server entry without optional env keys", () => {
    expect(createGitHubGraphQLMcpServerEntry()).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js"), "--server", "github"],
      env: {
        GITHUB_GRAPHQL_API_URL: DEFAULT_GITHUB_GRAPHQL_API_URL,
      },
    });
  });

  it("includes only provided optional environment values", () => {
    expect(
      createGitHubGraphQLMcpServerEntry({
        githubToken: "ghs_token",
        githubProjectId: "project-1",
        githubGraphqlApiUrl: "https://api.github.com/graphql",
      })
    ).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js"), "--server", "github"],
      env: {
        GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
        GITHUB_GRAPHQL_TOKEN: "ghs_token",
        GITHUB_PROJECT_ID: "project-1",
      },
    });
  });
});

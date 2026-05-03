import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GITHUB_GRAPHQL_API_URL,
  createGitHubGraphQLMcpServerEntry,
} from "./mcp-entry.js";
import { resolveGitHubGraphQLToken } from "./tool.js";

describe("resolveGitHubGraphQLToken", () => {
  it("returns a static token when provided", async () => {
    await expect(
      resolveGitHubGraphQLToken({
        token: "ghs_static",
      })
    ).resolves.toBe("ghs_static");
  });

  it("reuses a cached broker token when it is still fresh", async () => {
    const fetchImpl = vi.fn();

    const token = await resolveGitHubGraphQLToken(
      {
        tokenBrokerUrl: "http://127.0.0.1/runtime-token",
        tokenBrokerSecret: "runtime-secret",
        tokenCachePath: "/tmp/github-token-cache.json",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        now: new Date("2026-03-07T10:00:00.000Z"),
        readFileImpl: vi.fn().mockResolvedValue(
          JSON.stringify({
            token: "ghs_cached",
            expiresAt: "2026-03-07T10:10:00.000Z",
          })
        ) as never,
        writeFileImpl: vi.fn() as never,
      }
    );

    expect(token).toBe("ghs_cached");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes through the broker when the cache is missing", async () => {
    const writeFileImpl = vi.fn().mockResolvedValue(undefined);

    const token = await resolveGitHubGraphQLToken(
      {
        tokenBrokerUrl: "http://127.0.0.1/runtime-token",
        tokenBrokerSecret: "runtime-secret",
        tokenCachePath: "/tmp/github-token-cache.json",
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              token: "ghs_brokered",
              expiresAt: "2026-03-07T10:20:00.000Z",
            }),
            { status: 200 }
          )
        ) as never,
        readFileImpl: vi.fn().mockRejectedValue(new Error("missing")) as never,
        writeFileImpl: writeFileImpl as never,
      }
    );

    expect(token).toBe("ghs_brokered");
    expect(writeFileImpl).toHaveBeenCalledWith(
      "/tmp/github-token-cache.json",
      JSON.stringify({
        token: "ghs_brokered",
        expiresAt: "2026-03-07T10:20:00.000Z",
      }),
      "utf8"
    );
  });
});

describe("createGitHubGraphQLMcpServerEntry", () => {
  it("creates a default MCP server entry without optional env keys", () => {
    expect(createGitHubGraphQLMcpServerEntry()).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js")],
      env: {
        GITHUB_GRAPHQL_API_URL: DEFAULT_GITHUB_GRAPHQL_API_URL,
      },
    });
  });

  it("includes only provided optional environment values", () => {
    expect(createGitHubGraphQLMcpServerEntry({
      githubToken: "ghs_token",
      githubTokenBrokerUrl: "http://127.0.0.1/runtime-token",
      githubTokenBrokerSecret: "secret",
      githubTokenCachePath: "/tmp/github-token-cache.json",
      githubProjectId: "project-1",
      githubGraphqlApiUrl: "https://github.example/api/graphql",
    })).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js")],
      env: {
        GITHUB_GRAPHQL_API_URL: "https://github.example/api/graphql",
        GITHUB_GRAPHQL_TOKEN: "ghs_token",
        GITHUB_TOKEN_BROKER_URL: "http://127.0.0.1/runtime-token",
        GITHUB_TOKEN_BROKER_SECRET: "secret",
        GITHUB_TOKEN_CACHE_PATH: "/tmp/github-token-cache.json",
        GITHUB_PROJECT_ID: "project-1",
      },
    });
  });
});

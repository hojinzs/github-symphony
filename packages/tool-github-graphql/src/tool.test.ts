import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const tempRoots: string[] = [];

describe("resolveGitHubGraphQLToken", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) =>
        rm(root, {
          force: true,
          recursive: true,
        })
      )
    );
  });

  it("returns a static token when provided", async () => {
    await expect(
      resolveGitHubGraphQLToken({
        token: "ghs_static",
      })
    ).resolves.toBe("ghs_static");
  });

  it("reuses a cached broker token when it is still fresh", async () => {
    const chmodImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn();

    const token = await resolveGitHubGraphQLToken(
      {
        tokenBrokerUrl: "https://broker.example/runtime-token",
        tokenBrokerSecret: "runtime-secret",
        tokenCachePath: "/tmp/github-token-cache.json",
      },
      {
        chmodImpl: chmodImpl as never,
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
    expect(chmodImpl).toHaveBeenCalledWith(
      "/tmp/github-token-cache.json",
      0o600
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes through the broker when the cache is missing", async () => {
    const chmodImpl = vi.fn().mockResolvedValue(undefined);
    const mkdirImpl = vi.fn().mockResolvedValue(undefined);
    const writeFileImpl = vi.fn().mockResolvedValue(undefined);

    const token = await resolveGitHubGraphQLToken(
      {
        tokenBrokerUrl: "https://broker.example/runtime-token",
        tokenBrokerSecret: "runtime-secret",
        tokenCachePath: "/tmp/github-token-cache.json",
      },
      {
        chmodImpl: chmodImpl as never,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              token: "ghs_brokered",
              expiresAt: "2026-03-07T10:20:00.000Z",
            }),
            { status: 200 }
          )
        ) as never,
        mkdirImpl: mkdirImpl as never,
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
      { encoding: "utf8", mode: 0o600 }
    );
    expect(mkdirImpl).toHaveBeenCalledWith("/tmp", {
      recursive: true,
      mode: 0o700,
    });
    expect(chmodImpl).toHaveBeenNthCalledWith(
      1,
      "/tmp/github-token-cache.json",
      0o600
    );
    expect(chmodImpl).toHaveBeenNthCalledWith(
      2,
      "/tmp/github-token-cache.json",
      0o600
    );
    expect(chmodImpl.mock.invocationCallOrder[0]).toBeLessThan(
      writeFileImpl.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("corrects a reused broker token cache to owner-only permissions", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "github-token-cache-"));
    tempRoots.push(cacheDir);
    const cachePath = join(cacheDir, "token.json");
    await chmod(cacheDir, 0o755);
    await writeFile(
      cachePath,
      JSON.stringify({
        token: "ghs_cached",
        expiresAt: "2026-03-07T10:10:00.000Z",
      }),
      "utf8"
    );
    await chmod(cachePath, 0o644);

    await expect(
      resolveGitHubGraphQLToken(
        {
          tokenBrokerUrl: "https://broker.example/runtime-token",
          tokenBrokerSecret: "runtime-secret",
          tokenCachePath: cachePath,
        },
        {
          fetchImpl: vi.fn() as never,
          now: new Date("2026-03-07T10:00:00.000Z"),
        }
      )
    ).resolves.toBe("ghs_cached");

    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it("stores broker token cache with owner-only permissions in a new parent", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "github-token-cache-"));
    tempRoots.push(tempRoot);
    const cacheDir = join(tempRoot, "cache");
    const cachePath = join(cacheDir, "token.json");

    await expect(
      resolveGitHubGraphQLToken(
        {
          tokenBrokerUrl: "https://broker.example/runtime-token",
          tokenBrokerSecret: "runtime-secret",
          tokenCachePath: cachePath,
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
          now: new Date("2026-03-07T10:00:00.000Z"),
        }
      )
    ).resolves.toBe("ghs_brokered");

    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it("does not chmod caller-owned token cache parents", async () => {
    const chmodImpl = vi.fn().mockResolvedValue(undefined);
    const mkdirImpl = vi.fn().mockResolvedValue(undefined);
    const writeFileImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      resolveGitHubGraphQLToken(
        {
          tokenBrokerUrl: "https://broker.example/runtime-token",
          tokenBrokerSecret: "runtime-secret",
          tokenCachePath: ".github-token-cache.json",
        },
        {
          chmodImpl: chmodImpl as never,
          fetchImpl: vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                token: "ghs_brokered",
                expiresAt: "2026-03-07T10:20:00.000Z",
              }),
              { status: 200 }
            )
          ) as never,
          mkdirImpl: mkdirImpl as never,
          readFileImpl: vi
            .fn()
            .mockRejectedValue(new Error("missing")) as never,
          writeFileImpl: writeFileImpl as never,
        }
      )
    ).resolves.toBe("ghs_brokered");

    expect(mkdirImpl).toHaveBeenCalledWith(".", {
      recursive: true,
      mode: 0o700,
    });
    expect(chmodImpl).not.toHaveBeenCalledWith(".", 0o700);
    expect(chmodImpl).toHaveBeenCalledWith(".github-token-cache.json", 0o600);
  });

  it("rejects non-https token broker URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      resolveGitHubGraphQLToken(
        {
          tokenBrokerUrl: "http://broker.example/runtime-token",
          tokenBrokerSecret: "runtime-secret",
        },
        {
          fetchImpl: fetchImpl as never,
        }
      )
    ).rejects.toThrow(/must use https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects private token broker URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      resolveGitHubGraphQLToken(
        {
          tokenBrokerUrl: "https://169.254.169.254/latest/meta-data",
          tokenBrokerSecret: "runtime-secret",
        },
        {
          fetchImpl: fetchImpl as never,
        }
      )
    ).rejects.toThrow(/private networks/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects IPv4-mapped private token broker URLs before HTTP", async () => {
    const fetchImpl = vi.fn();

    await expect(
      resolveGitHubGraphQLToken(
        {
          tokenBrokerUrl: "https://[::ffff:127.0.0.1]/runtime-token",
          tokenBrokerSecret: "runtime-secret",
        },
        {
          fetchImpl: fetchImpl as never,
        }
      )
    ).rejects.toThrow(/private networks/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["localhost.", "metadata.google.internal."])(
    "rejects trailing-dot private broker host %s before HTTP",
    async (hostname) => {
      const fetchImpl = vi.fn();

      await expect(
        resolveGitHubGraphQLToken(
          {
            tokenBrokerUrl: `https://${hostname}/runtime-token`,
            tokenBrokerSecret: "runtime-secret",
          },
          {
            fetchImpl: fetchImpl as never,
          }
        )
      ).rejects.toThrow(/private networks/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );
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
        githubTokenBrokerUrl: "https://broker.example/runtime-token",
        githubTokenBrokerSecret: "secret",
        githubTokenCachePath: "/tmp/github-token-cache.json",
        githubProjectId: "project-1",
        githubGraphqlApiUrl: "https://api.github.com/graphql",
      })
    ).toEqual({
      command: "node",
      args: [expect.stringContaining("mcp-server.js"), "--server", "github"],
      env: {
        GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
        GITHUB_GRAPHQL_TOKEN: "ghs_token",
        GITHUB_TOKEN_BROKER_URL: "https://broker.example/runtime-token",
        GITHUB_TOKEN_BROKER_SECRET: "secret",
        GITHUB_TOKEN_CACHE_PATH: "/tmp/github-token-cache.json",
        GITHUB_PROJECT_ID: "project-1",
      },
    });
  });
});

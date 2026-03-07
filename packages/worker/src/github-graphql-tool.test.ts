import { describe, expect, it, vi } from "vitest";
import { resolveGitHubGraphQLToken } from "./github-graphql-tool.js";

describe("resolveGitHubGraphQLToken", () => {
  it("returns a static token when provided", async () => {
    await expect(
      resolveGitHubGraphQLToken({
        token: "ghs_static"
      })
    ).resolves.toBe("ghs_static");
  });

  it("reuses a cached broker token when it is still fresh", async () => {
    const fetchImpl = vi.fn();

    const token = await resolveGitHubGraphQLToken(
      {
        tokenBrokerUrl: "http://127.0.0.1/runtime-token",
        tokenBrokerSecret: "runtime-secret",
        tokenCachePath: "/tmp/github-token-cache.json"
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        now: new Date("2026-03-07T10:00:00.000Z"),
        readFileImpl: vi.fn().mockResolvedValue(
          JSON.stringify({
            token: "ghs_cached",
            expiresAt: "2026-03-07T10:10:00.000Z"
          })
        ) as never,
        writeFileImpl: vi.fn() as never
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
        tokenCachePath: "/tmp/github-token-cache.json"
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              token: "ghs_brokered",
              expiresAt: "2026-03-07T10:20:00.000Z"
            }),
            { status: 200 }
          )
        ) as never,
        readFileImpl: vi.fn().mockRejectedValue(new Error("missing")) as never,
        writeFileImpl: writeFileImpl as never
      }
    );

    expect(token).toBe("ghs_brokered");
    expect(writeFileImpl).toHaveBeenCalledWith(
      "/tmp/github-token-cache.json",
      JSON.stringify({
        token: "ghs_brokered",
        expiresAt: "2026-03-07T10:20:00.000Z"
      }),
      "utf8"
    );
  });
});

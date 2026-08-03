import { describe, expect, it } from "vitest";
import {
  extractToolRateLimitPayload,
  guardDynamicToolRateLimit,
} from "./tool-rate-limit.js";

describe("extractToolRateLimitPayload", () => {
  it("extracts GitHub GraphQL cost metadata from a tool result", () => {
    expect(
      extractToolRateLimitPayload(
        JSON.stringify({
          data: { viewer: { login: "octo" } },
          rateLimits: {
            source: "github",
            cost: 3,
            remaining: 4_997,
            resource: "graphql",
          },
        })
      )
    ).toEqual({
      source: "github",
      cost: 3,
      remaining: 4_997,
      resource: "graphql",
    });
  });

  it("ignores malformed or uninstrumented tool output", () => {
    expect(extractToolRateLimitPayload("not-json")).toBeNull();
    expect(
      extractToolRateLimitPayload(JSON.stringify({ data: { viewer: null } }))
    ).toBeNull();
  });

  it("blocks the next github_graphql child when the previous child exhausted its budget", async () => {
    const rateLimits = extractToolRateLimitPayload(
      JSON.stringify({
        rateLimits: {
          source: "github",
          resource: "graphql",
          remaining: 0,
          resetAt: "2026-08-03T02:00:00.000Z",
        },
      })
    );

    await expect(
      guardDynamicToolRateLimit("github_graphql", rateLimits, {
        now: () => Date.parse("2026-08-03T00:00:00.000Z"),
      })
    ).rejects.toMatchObject({
      name: "GitHubGraphQLRateLimitError",
      rateLimits: expect.objectContaining({ remaining: 0 }),
    });
  });

  it("does not apply the GitHub guard to Linear or non-provider snapshots", async () => {
    await expect(
      guardDynamicToolRateLimit("linear_graphql", {
        source: "linear",
        resource: "graphql",
        remaining: 0,
      })
    ).resolves.toBe(false);
    await expect(
      guardDynamicToolRateLimit("github_graphql", {
        source: "codex",
        resource: "tokens",
        remaining: 0,
      })
    ).resolves.toBe(false);
  });
});

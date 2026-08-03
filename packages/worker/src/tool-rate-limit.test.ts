import { describe, expect, it } from "vitest";
import { extractToolRateLimitPayload } from "./tool-rate-limit.js";

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
});

import { describe, expect, it } from "vitest";
import { redactObservabilitySecrets } from "./redaction.js";

describe("redactObservabilitySecrets", () => {
  it("redacts Linear API keys and Authorization headers recursively", () => {
    const redacted = redactObservabilitySecrets({
      event: "tool-call",
      LINEAR_API_KEY: "lin_secret",
      headers: {
        authorization: "Bearer lin_secret",
        authorizationHeader: "Bearer lin_secret",
      },
      linearApiKey: "lin_secret",
      githubGraphqlToken: "lin_secret",
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
      nested: [
        {
          token: "lin_secret",
          accessToken: "lin_secret",
          bearerToken: "lin_secret",
          value: "safe",
        },
      ],
    });

    expect(redacted).toEqual({
      event: "tool-call",
      LINEAR_API_KEY: "[REDACTED]",
      headers: {
        authorization: "[REDACTED]",
        authorizationHeader: "[REDACTED]",
      },
      linearApiKey: "[REDACTED]",
      githubGraphqlToken: "[REDACTED]",
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
      nested: [
        {
          token: "[REDACTED]",
          accessToken: "[REDACTED]",
          bearerToken: "[REDACTED]",
          value: "safe",
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain("lin_secret");
  });
});

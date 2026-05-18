import { describe, expect, it } from "vitest";
import {
  redactObservabilitySecrets,
  redactObservabilitySecretsWithStats,
  redactObservabilityTextWithStats,
} from "./redaction.js";

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

  it("redacts structured and raw support diagnostics secrets with class counts", () => {
    const structured = redactObservabilitySecretsWithStats({
      token: "ghp_xxx",
      secret: "top-secret",
      apiKey: "sk-xxx",
      headers: {
        Authorization: "Authorization: Bearer abc123",
      },
      message: "X-API-Key: xxx",
    });
    const raw = redactObservabilityTextWithStats(
      [
        "Authorization: Bearer abc123",
        "GITHUB_TOKEN=ghp_xxx",
        "GITHUB_GRAPHQL_TOKEN=ghp_xxx",
        "LINEAR_API_KEY=lin_xxx",
        "OPENAI_API_KEY=sk-xxx",
        "X-API-Key: xxx",
        "token: xxx",
        "secret: xxx",
        "apiKey: xxx",
      ].join("\n")
    );
    const output = JSON.stringify(structured.value) + raw.value;

    for (const secret of ["abc123", "ghp_xxx", "lin_xxx", "sk-xxx", "xxx"]) {
      expect(output).not.toContain(secret);
    }
    expect([...structured.redactions, ...raw.redactions]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: "authorization_header" }),
        expect.objectContaining({ class: "env_token" }),
        expect.objectContaining({ class: "api_key" }),
        expect.objectContaining({ class: "secret_key" }),
      ])
    );
  });
});

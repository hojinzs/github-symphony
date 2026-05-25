import { describe, expect, it } from "vitest";
import {
  redactObservabilityDiagnosticsWithStats,
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

  it("keeps shared structured redaction key-focused", () => {
    const redacted = redactObservabilitySecrets({
      event: "worker",
      message: "token: ordinary-diagnostic-text",
    });

    expect(redacted).toEqual({
      event: "worker",
      message: "token: ordinary-diagnostic-text",
    });
  });

  it("redacts structured and raw support diagnostics secrets with class counts", () => {
    const structured = redactObservabilityDiagnosticsWithStats({
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
        '{"token":"json_token_value","secret":"json_secret_value","apiKey":"json_api_key_value"}',
      ].join("\n")
    );
    const output = JSON.stringify(structured.value) + raw.value;

    for (const secret of [
      "abc123",
      "ghp_xxx",
      "lin_xxx",
      "sk-xxx",
      "xxx",
      "json_token_value",
      "json_secret_value",
      "json_api_key_value",
    ]) {
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

  it("reports key-only structured redaction stats without scanning strings", () => {
    const structured = redactObservabilitySecretsWithStats({
      token: "ghp_xxx",
      message: "Authorization: Bearer abc123",
    });

    expect(structured.value).toEqual({
      token: "[REDACTED]",
      message: "Authorization: Bearer abc123",
    });
    expect(structured.redactions).toEqual([{ class: "env_token", count: 1 }]);
  });
});

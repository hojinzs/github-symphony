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

  it("redacts secrets embedded in persisted free-form fields", () => {
    const redacted = redactObservabilitySecrets({
      event: "worker",
      message: "request failed with github_pat_11AA22bb33CC44dd55EE66ff",
      error: "Authorization: token gho_11AA22bb33CC44dd55EE66ff",
      reason: "upstream returned ghs_11AA22bb33CC44dd55EE66ff",
      stderr: "CUSTOM_CREDENTIAL=plain-text-secret",
    });

    expect(redacted).toEqual({
      event: "worker",
      message: "request failed with [REDACTED]",
      error: "Authorization: [REDACTED]",
      reason: "upstream returned [REDACTED]",
      stderr: "CUSTOM_CREDENTIAL=[REDACTED]",
    });
  });

  it("redacts URL credentials, sensitive query values, and opaque high-entropy values", () => {
    const highEntropySecret = "A9fK2mP7qR4tV8xZ1bC6dE3gH5jL0nQs";
    const redacted = redactObservabilitySecrets({
      message:
        "clone https://oauth2:github_pat_11AA22bb33CC44dd55EE66ff@github.com/org/repo",
      reason:
        "callback https://example.test/path?custom_access_token=gho_11AA22bb33CC44dd55EE66ff&safe=yes",
      stderr: `CUSTOM_VALUE=${highEntropySecret}`,
      safe: "commit 0123456789abcdef0123456789abcdef01234567",
      safePath: "/tmp/doctor-config-gMkszL/WORKFLOW.md",
      safeArtifact: "gh-symphony-support-bundle-20260802-145748Z",
    });
    const output = JSON.stringify(redacted);

    expect(redacted).toEqual({
      message: "clone https://[REDACTED]@github.com/org/repo",
      reason:
        "callback https://example.test/path?custom_access_token=[REDACTED]&safe=yes",
      stderr: "CUSTOM_VALUE=[REDACTED]",
      safe: "commit 0123456789abcdef0123456789abcdef01234567",
      safePath: "/tmp/doctor-config-gMkszL/WORKFLOW.md",
      safeArtifact: "gh-symphony-support-bundle-20260802-145748Z",
    });
    expect(output).not.toContain("github_pat_");
    expect(output).not.toContain("gho_");
    expect(output).not.toContain(highEntropySecret);
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

  it("preserves JSON and NDJSON syntax when redacting quoted values", () => {
    const raw = [
      '{"token":"abc def","message":"safe"}',
      '{"custom_secret":"line one","status":"failed"}',
    ].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);
    const records = redacted.value.split("\n").map((line) => JSON.parse(line));

    expect(records).toEqual([
      { token: "[REDACTED]", message: "safe" },
      { custom_secret: "[REDACTED]", status: "failed" },
    ]);
    expect(redacted.redactions).toEqual([
      { class: "env_token", count: 1 },
      { class: "secret_key", count: 1 },
    ]);
  });

  it("preserves JSON when a sensitive query parameter is last in a URL", () => {
    const raw = JSON.stringify({
      url: "https://example.test/?access_token=abc",
      status: "failed",
    });

    const redacted = redactObservabilityTextWithStats(raw);

    expect(JSON.parse(redacted.value)).toEqual({
      url: "https://example.test/?access_token=[REDACTED]",
      status: "failed",
    });
    expect(redacted.value).not.toContain("abc");
  });

  it("preserves JSON delimiters when redacting Authorization values", () => {
    const raw = JSON.stringify({
      error: "Authorization: Basic YWJjZA==",
      status: "failed",
    });

    const redacted = redactObservabilityTextWithStats(raw);

    expect(JSON.parse(redacted.value)).toEqual({
      error: "Authorization: [REDACTED]",
      status: "failed",
    });
    expect(redacted.value).not.toContain("YWJjZA==");
  });

  it("redacts quoted values containing escaped quotes without leaking fragments", () => {
    const raw = JSON.stringify({
      password: 'abc "def" rest',
      status: "failed",
    });

    const redacted = redactObservabilityTextWithStats(raw);

    expect(JSON.parse(redacted.value)).toEqual({
      password: "[REDACTED]",
      status: "failed",
    });
    for (const fragment of ["abc", "def", "rest"]) {
      expect(redacted.value).not.toContain(fragment);
    }
  });

  it("redacts YAML doubled-quote values without leaking fragments", () => {
    const raw = "password: 'abc''def'\nstatus: failed";

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe("password: '[REDACTED]'\nstatus: failed");
    for (const fragment of ["abc", "def"]) {
      expect(redacted.value).not.toContain(fragment);
    }
  });

  it("redacts complete YAML plain scalars without leaking words", () => {
    const raw =
      "password: correct horse battery staple # diagnostic\nstatus: failed";

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe(
      "password: [REDACTED] # diagnostic\nstatus: failed"
    );
    for (const fragment of ["correct", "horse", "battery", "staple"]) {
      expect(redacted.value).not.toContain(fragment);
    }
  });

  it("redacts YAML block scalar payloads through the indentation boundary", () => {
    const raw = [
      "config:",
      "  password: |-",
      "    correct horse battery staple",
      "    second secret line",
      "  status: failed",
      "result: failed",
    ].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe(
      [
        "config:",
        "  password: [REDACTED]",
        "  status: failed",
        "result: failed",
      ].join("\n")
    );
    for (const fragment of [
      "correct",
      "horse",
      "battery",
      "staple",
      "second secret line",
    ]) {
      expect(redacted.value).not.toContain(fragment);
    }
  });

  it("redacts complete unquoted secret values containing punctuation", () => {
    const raw = ["GITHUB_TOKEN=abc,def", "CUSTOM_PASSWORD=abc;def"].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe(
      ["GITHUB_TOKEN=[REDACTED]", "CUSTOM_PASSWORD=[REDACTED]"].join("\n")
    );
    for (const fragment of ["abc", "def"]) {
      expect(redacted.value).not.toContain(fragment);
    }
  });

  it("redacts YAML block scalars with digit-first modifiers", () => {
    const raw = [
      "password: |2-",
      "  correct horse battery staple",
      "apiKey: |-2",
      "  second secret line",
      "status: failed",
    ].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe(
      ["password: [REDACTED]", "apiKey: [REDACTED]", "status: failed"].join(
        "\n"
      )
    );
    expect(redacted.value).not.toContain("correct horse battery staple");
    expect(redacted.value).not.toContain("second secret line");
  });

  it("preserves YAML siblings after sequence block scalar payloads", () => {
    const raw = [
      "items:",
      "  - password: |-",
      "      correct horse battery staple",
      "    status: failed",
      "next: ok",
    ].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe(
      [
        "items:",
        "  - password: [REDACTED]",
        "    status: failed",
        "next: ok",
      ].join("\n")
    );
    expect(redacted.value).not.toContain("correct horse battery staple");
  });

  it("consumes JSON delimiter characters in raw assignments", () => {
    const raw = ["GITHUB_TOKEN=abc}def", "CUSTOM_PASSWORD=one]two"].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe(
      ["GITHUB_TOKEN=[REDACTED]", "CUSTOM_PASSWORD=[REDACTED]"].join("\n")
    );
    for (const fragment of ["abc", "def", "one", "two"]) {
      expect(redacted.value).not.toContain(fragment);
    }
  });

  it("preserves adjacent compact log fields after unquoted secrets", () => {
    const raw = ["token=abc,status=failed", "password=abc;result=denied"].join(
      "\n"
    );

    const redacted = redactObservabilityTextWithStats(raw);

    expect(redacted.value).toBe(
      [
        "token=[REDACTED],status=failed",
        "password=[REDACTED];result=denied",
      ].join("\n")
    );
    expect(redacted.value).not.toContain("abc");
  });

  it("preserves JSON when redacting sensitive literal values", () => {
    const raw = [
      '{"token":123,"status":"failed"}',
      '{"custom_secret":false,"status":"failed"}',
      '{"password":null,"status":"failed"}',
    ].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);
    const records = redacted.value.split("\n").map((line) => JSON.parse(line));

    expect(records).toEqual([
      { token: "[REDACTED]", status: "failed" },
      { custom_secret: "[REDACTED]", status: "failed" },
      { password: "[REDACTED]", status: "failed" },
    ]);
    expect(redacted.redactions).toEqual([
      { class: "env_token", count: 1 },
      { class: "secret_key", count: 2 },
    ]);
  });

  it("preserves token usage metrics in raw turn-completed NDJSON", () => {
    const raw = JSON.stringify({
      event: "turn_completed",
      githubGraphqlToken: "abc",
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    });

    const redacted = redactObservabilityTextWithStats(raw);

    expect(JSON.parse(redacted.value)).toEqual({
      event: "turn_completed",
      githubGraphqlToken: "[REDACTED]",
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    });
    expect(redacted.redactions).toEqual([{ class: "env_token", count: 1 }]);
  });

  it("redacts sensitive JSON containers while preserving record syntax", () => {
    const raw = [
      '{"credentials":{"value":"container-secret"},"status":"failed"}',
      '{"credentials":["first-secret","second-secret"],"status":"failed"}',
    ].join("\n");

    const redacted = redactObservabilityTextWithStats(raw);
    const records = redacted.value.split("\n").map((line) => JSON.parse(line));

    expect(records).toEqual([
      { credentials: "[REDACTED]", status: "failed" },
      { credentials: "[REDACTED]", status: "failed" },
    ]);
    expect(redacted.value).not.toContain("container-secret");
    expect(redacted.value).not.toContain("first-secret");
    expect(redacted.value).not.toContain("second-secret");
  });

  it("reports structured and free-form redaction stats", () => {
    const structured = redactObservabilitySecretsWithStats({
      token: "ghp_xxx",
      message: "Authorization: Bearer abc123",
    });

    expect(structured.value).toEqual({
      token: "[REDACTED]",
      message: "Authorization: [REDACTED]",
    });
    expect(structured.redactions).toEqual([
      { class: "authorization_header", count: 1 },
      { class: "env_token", count: 1 },
    ]);
  });

  it("preserves redaction classes for raw assignments", () => {
    const redacted = redactObservabilityTextWithStats(
      ["GITHUB_TOKEN=abc", "OPENAI_API_KEY=def"].join("\n")
    );

    expect(redacted.value).toBe(
      ["GITHUB_TOKEN=[REDACTED]", "OPENAI_API_KEY=[REDACTED]"].join("\n")
    );
    expect(redacted.redactions).toEqual([
      { class: "api_key", count: 1 },
      { class: "env_token", count: 1 },
    ]);
  });

  it("redacts standard Base64 secrets containing slashes without masking paths", () => {
    const base64Secret = "Ab3dEf5hIj7kLm9nOp1q/Rs3tUv5wXy7zA9bCd2e";
    const slashPrefixedBase64Secret =
      "/Ab3dEf5hIj7kLm9nOp1q/Rs3tUv5wXy7zA9bCd2e";
    const relativePath = "runtime/projects/tenantA/ENG123/repository";
    const redacted = redactObservabilityTextWithStats(
      `error: upstream opaque credential ${base64Secret}\nerror: slash-prefixed credential ${slashPrefixedBase64Secret}\nworking directory ${relativePath}\nartifact at /tmp/doctor-config-gMkszL/WORKFLOW.md`
    );

    expect(redacted.value).toBe(
      `error: upstream opaque credential [REDACTED]\nerror: slash-prefixed credential [REDACTED]\nworking directory ${relativePath}\nartifact at /tmp/doctor-config-gMkszL/WORKFLOW.md`
    );
    expect(redacted.value).not.toContain(base64Secret);
    expect(redacted.value).not.toContain(slashPrefixedBase64Secret);
  });

  it("preserves absolute paths under arbitrary configured roots", () => {
    const workingDirectory = "/data/workspaces/tenantA/ENG123/repository";

    const redacted = redactObservabilitySecrets({ workingDirectory });

    expect(redacted).toEqual({ workingDirectory });
  });

  it("redacts slash-delimited Base64 that resembles a path without path context", () => {
    const base64Secret = "/abc/DEF/Gh1jKl3mNo5pQr7sTu9vWxYzAbCdEfG";

    const redacted = redactObservabilityTextWithStats(
      `message: upstream opaque credential ${base64Secret}`
    );

    expect(redacted.value).toBe(
      "message: upstream opaque credential [REDACTED]"
    );
    expect(redacted.value).not.toContain(base64Secret);
  });
});

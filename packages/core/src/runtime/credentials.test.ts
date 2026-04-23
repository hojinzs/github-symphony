import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeCredentialError,
  extractEnvForClaude,
  extractEnvForCodex,
  readAgentCredentialCache,
  shouldReuseAgentCredentialCache,
  TOKEN_REUSE_WINDOW_MS,
  writeAgentCredentialCache,
} from "./credentials.js";

describe("extractEnvForCodex", () => {
  it("keeps the existing OpenAI runtime keys only", () => {
    expect(
      extractEnvForCodex({
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "https://openai.example.test/v1",
        OPENAI_PROJECT: "project-123",
        ANTHROPIC_API_KEY: "sk-anthropic",
      })
    ).toEqual({
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://openai.example.test/v1",
      OPENAI_PROJECT: "project-123",
    });
  });
});

describe("extractEnvForClaude", () => {
  it("returns the Anthropic API key", () => {
    expect(
      extractEnvForClaude({
        ANTHROPIC_API_KEY: "sk-anthropic",
        OPENAI_API_KEY: "sk-openai",
      })
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-anthropic",
    });
  });

  it("fails with a clear missing-key error", () => {
    expect(() => extractEnvForClaude({})).toThrowError(
      new AgentRuntimeCredentialError(
        "ANTHROPIC_API_KEY is required in the credential broker response."
      )
    );
  });
});

describe("agent credential cache reuse", () => {
  it("reuses a cache entry when expires_at remains outside the reuse window", () => {
    expect(
      shouldReuseAgentCredentialCache(
        {
          env: { OPENAI_API_KEY: "sk-openai" },
          expires_at: "2026-04-22T10:10:00.000Z",
          cachedAt: "2026-04-22T10:00:00.000Z",
        },
        new Date("2026-04-22T10:00:00.000Z")
      )
    ).toBe(true);
  });

  it("does not reuse a cache entry when expires_at falls inside the reuse window", () => {
    expect(
      shouldReuseAgentCredentialCache(
        {
          env: { OPENAI_API_KEY: "sk-openai" },
          expires_at: new Date(
            Date.parse("2026-04-22T10:00:00.000Z") + TOKEN_REUSE_WINDOW_MS
          ).toISOString(),
          cachedAt: "2026-04-22T09:59:00.000Z",
        },
        new Date("2026-04-22T10:00:00.000Z")
      )
    ).toBe(false);
  });

  it("does not reuse an invalid or expired cache entry", () => {
    expect(
      shouldReuseAgentCredentialCache(
        {
          env: { OPENAI_API_KEY: "sk-openai" },
          expires_at: "not-a-date",
          cachedAt: "2026-04-22T10:00:00.000Z",
        },
        new Date("2026-04-22T10:00:00.000Z")
      )
    ).toBe(false);
    expect(
      shouldReuseAgentCredentialCache(
        {
          env: { OPENAI_API_KEY: "sk-openai" },
          expires_at: "2026-04-22T09:59:00.000Z",
          cachedAt: "2026-04-22T09:58:00.000Z",
        },
        new Date("2026-04-22T10:00:00.000Z")
      )
    ).toBe(false);
  });

  it("reuses a legacy cache entry that has no expires_at", () => {
    expect(
      shouldReuseAgentCredentialCache(
        {
          env: { OPENAI_API_KEY: "sk-openai" },
          cachedAt: "2026-04-22T10:00:00.000Z",
        },
        new Date("2026-04-22T11:00:00.000Z")
      )
    ).toBe(true);
  });
});

describe("agent credential cache io", () => {
  it("reads legacy cache files without expires_at", async () => {
    const entry = await readAgentCredentialCache(
      "/tmp/agent-cache.json",
      vi
        .fn()
        .mockResolvedValue(JSON.stringify({ env: { OPENAI_API_KEY: "sk-openai" } })) as never
    );

    expect(entry).toEqual({
      env: { OPENAI_API_KEY: "sk-openai" },
      expires_at: undefined,
      cachedAt: new Date(0).toISOString(),
    });
  });

  it("writes expires_at alongside cachedAt", async () => {
    const writeFileImpl = vi.fn().mockResolvedValue(undefined);

    await writeAgentCredentialCache(
      "/tmp/agent-cache.json",
      {
        env: { OPENAI_API_KEY: "sk-openai" },
        expires_at: "2026-04-22T10:10:00.000Z",
      },
      writeFileImpl as never,
      new Date("2026-04-22T10:00:00.000Z")
    );

    expect(writeFileImpl).toHaveBeenCalledWith(
      "/tmp/agent-cache.json",
      JSON.stringify({
        env: { OPENAI_API_KEY: "sk-openai" },
        expires_at: "2026-04-22T10:10:00.000Z",
        cachedAt: "2026-04-22T10:00:00.000Z",
      }),
      "utf8"
    );
  });
});

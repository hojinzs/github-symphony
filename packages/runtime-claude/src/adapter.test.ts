import { describe, expect, it } from "vitest";
import { resolveClaudeCredentials } from "./adapter.js";

describe("resolveClaudeCredentials", () => {
  it("extracts only the Anthropic runtime credential", () => {
    expect(
      resolveClaudeCredentials({
        env: {
          ANTHROPIC_API_KEY: "sk-anthropic",
          OPENAI_API_KEY: "sk-openai",
        },
        expires_at: "2026-04-22T10:10:00.000Z",
      })
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-anthropic",
    });
  });

  it("fails with a clear ANTHROPIC_API_KEY error when missing", () => {
    expect(() =>
      resolveClaudeCredentials({
        env: {},
      })
    ).toThrowError("ANTHROPIC_API_KEY");
  });
});

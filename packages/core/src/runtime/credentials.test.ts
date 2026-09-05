import { describe, expect, it } from "vitest";
import { extractEnvForCodex } from "./credentials.js";

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

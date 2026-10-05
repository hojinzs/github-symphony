import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  extractAbsoluteTokenUsage,
  persistTokenUsageArtifact,
  resolveTokenUsageArtifactPath,
} from "./token-usage.js";

describe("resolveTokenUsageArtifactPath", () => {
  it("returns null when the worker runtime paths are missing", () => {
    expect(resolveTokenUsageArtifactPath({})).toBeNull();
  });
});

describe("persistTokenUsageArtifact", () => {
  it("writes token usage into the worker runtime root", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "worker-token-usage-"));
    const env = {
      WORKSPACE_RUNTIME_DIR: runtimeRoot,
    } as NodeJS.ProcessEnv;

    await persistTokenUsageArtifact(env, {
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
    });

    await expect(
      readFile(join(runtimeRoot, "token-usage.json"), "utf8")
    ).resolves.toContain('"totalTokens": 19');
  });
});

describe("absolute token measurement", () => {
  it("accepts explicit measured zero and rejects absent counters", () => {
    expect(
      extractAbsoluteTokenUsage({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      })
    ).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(extractAbsoluteTokenUsage({})).toBeNull();
  });

  it("prefers wrapped absolute totals over last-token deltas", () => {
    expect(
      extractAbsoluteTokenUsage({
        info: {
          total_token_usage: {
            input_tokens: 140,
            output_tokens: 70,
            total_tokens: 210,
          },
          last_token_usage: { input_tokens: 9 },
        },
      })
    ).toEqual({ inputTokens: 140, outputTokens: 70, totalTokens: 210 });
    expect(
      extractAbsoluteTokenUsage({ last_token_usage: { input_tokens: 9 } })
    ).toBeNull();
  });

  it("leaves generic usage maps uninterpreted", () => {
    expect(
      extractAbsoluteTokenUsage({
        result: { usage: { input_tokens: 90, output_tokens: 30 } },
      })
    ).toBeNull();
  });

  it.each([-1, NaN, Infinity])(
    "rejects invalid absolute counts (%s)",
    (count) => {
      expect(
        extractAbsoluteTokenUsage({ input_tokens: count, output_tokens: 1 })
      ).toBeNull();
    }
  );
});

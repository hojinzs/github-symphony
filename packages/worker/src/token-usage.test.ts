import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
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

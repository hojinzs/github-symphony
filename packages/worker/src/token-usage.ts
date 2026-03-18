import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export async function persistTokenUsageArtifact(
  env: NodeJS.ProcessEnv,
  tokenUsage: TokenUsage
): Promise<void> {
  const artifactPath = resolveTokenUsageArtifactPath(env);
  if (!artifactPath) {
    return;
  }

  try {
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      JSON.stringify(tokenUsage, null, 2) + "\n",
      "utf8"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[worker] failed to persist token usage artifact: ${message}\n`
    );
  }
}

export function resolveTokenUsageArtifactPath(
  env: NodeJS.ProcessEnv
): string | null {
  const workspaceRuntimeDir = env.WORKSPACE_RUNTIME_DIR;
  if (!workspaceRuntimeDir) {
    return null;
  }

  return join(workspaceRuntimeDir, "token-usage.json");
}

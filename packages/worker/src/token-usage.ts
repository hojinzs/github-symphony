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

// Only call for runtime events that declare absolute usage. Generic usage maps
// and last-token deltas are not cumulative measurements.
export function extractAbsoluteTokenUsage(value: unknown): TokenUsage | null {
  const direct = parseTokenUsage(value);
  if (direct) {
    return direct;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "total_token_usage",
    "total",
    "tokenUsage",
    "token_usage",
    "info",
    "msg",
    "event",
    "data",
    "result",
    "payload",
  ];

  for (const key of preferredKeys) {
    if (key in record) {
      const nested = extractAbsoluteTokenUsage(record[key]);
      if (nested) {
        return nested;
      }
    }
  }

  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === "last_token_usage" || key === "last" || key === "usage") {
      continue;
    }
    const nested = extractAbsoluteTokenUsage(nestedValue);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const inputTokens =
    typeof record.input_tokens === "number"
      ? record.input_tokens
      : typeof record.inputTokens === "number"
        ? record.inputTokens
        : null;
  const outputTokens =
    typeof record.output_tokens === "number"
      ? record.output_tokens
      : typeof record.outputTokens === "number"
        ? record.outputTokens
        : null;
  const explicitTotalTokens =
    typeof record.total_tokens === "number"
      ? record.total_tokens
      : typeof record.totalTokens === "number"
        ? record.totalTokens
        : null;

  if (
    inputTokens === null &&
    outputTokens === null &&
    explicitTotalTokens === null
  ) {
    return null;
  }

  const normalizedInputTokens = inputTokens ?? 0;
  const normalizedOutputTokens = outputTokens ?? 0;
  const normalizedTotalTokens =
    explicitTotalTokens ?? normalizedInputTokens + normalizedOutputTokens;

  if (
    ![
      normalizedInputTokens,
      normalizedOutputTokens,
      normalizedTotalTokens,
    ].every((count) => Number.isFinite(count) && count >= 0)
  ) {
    return null;
  }

  return {
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    totalTokens:
      normalizedTotalTokens || normalizedInputTokens + normalizedOutputTokens,
  };
}

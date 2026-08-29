import type { CodexDynamicToolCallResponse } from "./codex-dynamic-tools.js";
import { guardDynamicToolRateLimit } from "./tool-rate-limit.js";

export async function executeRateLimitedCodexDynamicToolCall(options: {
  toolName: string;
  rateLimits: Record<string, unknown> | null;
  execute: () => Promise<CodexDynamicToolCallResponse>;
}): Promise<CodexDynamicToolCallResponse> {
  try {
    await guardDynamicToolRateLimit(options.toolName, options.rateLimits);
    return await options.execute();
  } catch (error) {
    return failure(
      "rate_limit_guard",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function failure(
  code: string,
  message: string
): CodexDynamicToolCallResponse {
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
  };
}

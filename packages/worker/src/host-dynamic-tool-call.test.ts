import { describe, expect, it, vi } from "vitest";
import { executeRateLimitedCodexDynamicToolCall } from "./host-dynamic-tool-call.js";

describe("executeRateLimitedCodexDynamicToolCall", () => {
  it("returns a structured tool error when the GitHub guard rejects", async () => {
    const execute = vi.fn();

    await expect(
      executeRateLimitedCodexDynamicToolCall({
        toolName: "github_graphql",
        rateLimits: {
          source: "github",
          resource: "graphql",
          remaining: 0,
          resetAt: "2099-01-01T00:00:00.000Z",
        },
        execute,
      })
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining('"code":"rate_limit_guard"'),
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createTrackerToolContext,
  executeCodexDynamicToolCall,
} from "./codex-dynamic-tools.js";

describe("Codex host dynamic tools", () => {
  const env = {
    SYMPHONY_ISSUE_ID: "issue-730",
    SYMPHONY_ISSUE_IDENTIFIER: "hojinzs/github-symphony#730",
    SYMPHONY_ISSUE_NATIVE_REF: '{"itemId":"PVTI_730"}',
    GITHUB_GRAPHQL_TOKEN: "host-token",
  };

  it("executes GitHub GraphQL in-process with the issue context", async () => {
    const executeGitHubGraphQL = vi.fn().mockResolvedValue({ data: "ok" });
    const context = createTrackerToolContext(env);

    const response = await executeCodexDynamicToolCall(
      "github_graphql",
      { query: "query { viewer { login } }" },
      context,
      env,
      { executeGitHubGraphQL }
    );

    expect(executeGitHubGraphQL).toHaveBeenCalledWith(
      { query: "query { viewer { login } }" },
      expect.objectContaining({ token: "host-token" }),
      expect.any(Function),
      {
        issue: {
          id: "issue-730",
          identifier: "hojinzs/github-symphony#730",
          nativeRef: { itemId: "PVTI_730" },
        },
      }
    );
    expect(response).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: '{"data":"ok"}' }],
    });
  });

  it("returns a structured error for an unknown tool and keeps the session usable", async () => {
    const context = createTrackerToolContext(env);

    const response = await executeCodexDynamicToolCall(
      "unsupported_tool",
      {},
      context,
      env
    );

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            error: {
              code: "unknown_tool",
              message: 'Tool "unsupported_tool" is not supported.',
            },
          }),
        },
      ],
    });
  });
});

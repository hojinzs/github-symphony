import { afterEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("executes the adapter-owned host tool with the issue context", async () => {
    const executeAgentTool = vi.fn().mockResolvedValue({ data: "ok" });
    const context = createTrackerToolContext(env);

    const response = await executeCodexDynamicToolCall(
      "github_graphql",
      { query: "query { viewer { login } }" },
      context,
      env,
      {
        adapters: [
          {
            agentToolSpecs: () => [
              {
                name: "github_graphql",
                description: "test",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
            executeAgentTool,
          },
        ],
      }
    );

    expect(executeAgentTool).toHaveBeenCalledWith(
      "github_graphql",
      { query: "query { viewer { login } }" },
      {
        issue: {
          id: "issue-730",
          identifier: "hojinzs/github-symphony#730",
          nativeRef: { itemId: "PVTI_730" },
        },
        environment: env,
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

  it("uses the selected adapter with host-process credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { login: "octo" } } }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchImpl);

    const response = await executeCodexDynamicToolCall(
      "github_graphql",
      { query: "query { viewer { login } }" },
      createTrackerToolContext(env),
      env
    );

    expect(response).toEqual({
      success: true,
      contentItems: [
        { type: "inputText", text: '{"data":{"viewer":{"login":"octo"}}}' },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer host-token",
        }),
      })
    );
  });

  it("routes GitHub tools alongside Linear tools and preserves loaded env", async () => {
    const github = vi.fn().mockResolvedValue({ provider: "github" });
    const linear = vi.fn().mockResolvedValue({ provider: "linear" });
    const response = await executeCodexDynamicToolCall(
      "github_graphql",
      { query: "query { viewer { login } }" },
      createTrackerToolContext({
        ...env,
        SYMPHONY_TRACKER_KIND: "linear",
        GITHUB_GRAPHQL_TOKEN: "dotenv-token",
      }),
      { ...env, SYMPHONY_TRACKER_KIND: "linear" },
      {
        adapters: [
          {
            agentToolSpecs: () => [
              {
                name: "github_graphql",
                description: "GitHub",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
            executeAgentTool: github,
          },
          {
            agentToolSpecs: () => [
              {
                name: "linear_graphql",
                description: "Linear",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
            executeAgentTool: linear,
          },
        ],
      }
    );

    expect(response.success).toBe(true);
    expect(github).toHaveBeenCalledWith(
      "github_graphql",
      expect.any(Object),
      expect.objectContaining({
        environment: expect.objectContaining({
          GITHUB_GRAPHQL_TOKEN: "dotenv-token",
        }),
      })
    );
    expect(linear).not.toHaveBeenCalled();
  });
});

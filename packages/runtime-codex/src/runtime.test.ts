import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeResolutionError,
  CODEX_PROTOCOL_EVENT_NAMES,
  buildCodexRuntimePlan,
  createCodexRuntimeAdapter,
  createGitCredentialHelperEnvironment,
  createGitHubGraphQLToolDefinition,
  getCodexObservabilityEventName,
  normalizeCodexRuntimeEvents,
  prepareCodexRuntimePlan,
  resolvePreparedAgentEnvironment,
  resolveAgentRuntimeEnvironment,
  launchCodexAppServer,
  resolveStagedCodexHome,
} from "./runtime.js";

describe("createGitHubGraphQLToolDefinition", () => {
  it("builds a runtime tool definition for brokered GitHub GraphQL access", () => {
    const tool = createGitHubGraphQLToolDefinition({
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-token.json",
      githubProjectId: "project-123",
    });

    expect(tool.name).toBe("github_graphql");
    expect(tool.command).toBe("node");
    expect(tool.args[0]).toContain("mcp-server.js");
    expect(tool.env).toEqual({
      GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
      GITHUB_TOKEN_BROKER_URL:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      GITHUB_TOKEN_BROKER_SECRET: "runtime-secret",
      GITHUB_TOKEN_CACHE_PATH: "/workspace-runtime/.github-token.json",
      GITHUB_PROJECT_ID: "project-123",
    });
  });
});

describe("buildCodexRuntimePlan", () => {
  it("prepares the codex app-server launch contract", () => {
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-token.json",
      githubProjectId: "project-123",
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
      extraEnv: {
        WORKER_PROFILE: "test",
      },
    });

    expect(plan.command).toBe("bash");
    expect(plan.args).toEqual(["-lc", "codex app-server"]);
    expect(plan.cwd).toBe("/tmp/workspace-123");
    expect(plan.tools).toHaveLength(1);
    expect(plan.env.CODEX_PROJECT_ID).toBe("workspace-123");
    expect(plan.env.GITHUB_GRAPHQL_TOOL_NAME).toBe("github_graphql");
    expect(plan.env.GITHUB_GRAPHQL_TOOL_COMMAND).toContain(
      "mcp-server.js"
    );
    expect(plan.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(plan.env.GIT_CONFIG_VALUE_0).toContain("git-credential-helper.js");
    expect(plan.env.WORKER_PROFILE).toBe("test");
    expect(plan.env.OPENAI_API_KEY).toBe("sk-ready-runtime");
    expect(plan.env.CODEX_HOME).toBe("/tmp/workspace-123/.codex-agent");
  });
});

describe("resolvePreparedAgentEnvironment", () => {
  it("filters direct agent env keys and stages CODEX_HOME", () => {
    expect(
      resolvePreparedAgentEnvironment("/tmp/workspace-123", {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "https://example.test/v1",
        UNRELATED: "ignored",
      })
    ).toEqual({
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://example.test/v1",
      CODEX_HOME: "/tmp/workspace-123/.codex-agent",
    });
  });
});

describe("createGitCredentialHelperEnvironment", () => {
  it("configures git to use a renewable credential helper", () => {
    const env = createGitCredentialHelperEnvironment({
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-token.json",
    });

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("git-credential-helper.js");
    expect(env.GITHUB_TOKEN_BROKER_URL).toContain("/runtime-credentials");
  });
});

describe("launchCodexAppServer", () => {
  it("spawns the runtime with the generated plan", () => {
    const spawnImpl = vi.fn().mockReturnValue({
      pid: 42,
    });

    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
    });

    const child = launchCodexAppServer(plan, spawnImpl);

    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "codex app-server"],
      {
        cwd: "/tmp/workspace-123",
        env: plan.env,
        stdio: "pipe",
      }
    );
    expect(child).toEqual({
      pid: 42,
    });
  });
});

describe("resolveAgentRuntimeEnvironment", () => {
  it("resolves brokered agent environment before launch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          env: {
            OPENAI_API_KEY: "sk-brokered-agent",
            ANTHROPIC_API_KEY: "sk-anthropic",
          },
          expires_at: "2026-04-22T10:10:00.000Z",
        }),
        { status: 200 }
      )
    );
    const writeFileImpl = vi.fn().mockResolvedValue(undefined);

    const env = await resolveAgentRuntimeEnvironment(
      {
        workingDirectory: "/tmp/workspace-123",
        agentCredentialBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-123/agent-credentials",
        agentCredentialBrokerSecret: "runtime-secret",
        agentCredentialCachePath: "/workspace-runtime/.agent-runtime-auth.json",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        writeFileImpl,
        now: new Date("2026-04-22T10:00:00.000Z"),
      }
    );

    expect(env).toEqual({
      OPENAI_API_KEY: "sk-brokered-agent",
      CODEX_HOME: "/tmp/workspace-123/.codex-agent",
    });
    expect(writeFileImpl).toHaveBeenCalledWith(
      "/workspace-runtime/.agent-runtime-auth.json",
      JSON.stringify({
        env: {
          OPENAI_API_KEY: "sk-brokered-agent",
          ANTHROPIC_API_KEY: "sk-anthropic",
        },
        expires_at: "2026-04-22T10:10:00.000Z",
        cachedAt: "2026-04-22T10:00:00.000Z",
      }),
      "utf8"
    );
  });

  it("reuses a cached broker response when expires_at is still fresh", async () => {
    const fetchImpl = vi.fn();

    const env = await resolveAgentRuntimeEnvironment(
      {
        workingDirectory: "/tmp/workspace-123",
        agentCredentialBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-123/agent-credentials",
        agentCredentialBrokerSecret: "runtime-secret",
        agentCredentialCachePath: "/workspace-runtime/.agent-runtime-auth.json",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        readFileImpl: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({
              env: {
                OPENAI_API_KEY: "sk-cached-agent",
                OPENAI_BASE_URL: "https://openai.example.test/v1",
              },
              expires_at: "2026-04-22T10:10:00.000Z",
              cachedAt: "2026-04-22T10:00:00.000Z",
            })
          ) as never,
        now: new Date("2026-04-22T10:00:00.000Z"),
      }
    );

    expect(env).toEqual({
      OPENAI_API_KEY: "sk-cached-agent",
      OPENAI_BASE_URL: "https://openai.example.test/v1",
      CODEX_HOME: "/tmp/workspace-123/.codex-agent",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes when the cached broker response is inside the reuse window", async () => {
    const writeFileImpl = vi.fn().mockResolvedValue(undefined);

    const env = await resolveAgentRuntimeEnvironment(
      {
        workingDirectory: "/tmp/workspace-123",
        agentCredentialBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-123/agent-credentials",
        agentCredentialBrokerSecret: "runtime-secret",
        agentCredentialCachePath: "/workspace-runtime/.agent-runtime-auth.json",
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              env: {
                OPENAI_API_KEY: "sk-refreshed-agent",
              },
              expires_at: "2026-04-22T10:15:00.000Z",
            }),
            { status: 200 }
          )
        ) as never,
        readFileImpl: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({
              env: {
                OPENAI_API_KEY: "sk-stale-agent",
              },
              expires_at: "2026-04-22T10:00:30.000Z",
              cachedAt: "2026-04-22T09:50:00.000Z",
            })
          ) as never,
        writeFileImpl,
        now: new Date("2026-04-22T10:00:00.000Z"),
      }
    );

    expect(env).toEqual({
      OPENAI_API_KEY: "sk-refreshed-agent",
      CODEX_HOME: "/tmp/workspace-123/.codex-agent",
    });
    expect(writeFileImpl).toHaveBeenCalledOnce();
  });

  it("reuses a legacy cache entry without expires_at", async () => {
    const fetchImpl = vi.fn();

    const env = await resolveAgentRuntimeEnvironment(
      {
        workingDirectory: "/tmp/workspace-123",
        agentCredentialBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-123/agent-credentials",
        agentCredentialBrokerSecret: "runtime-secret",
        agentCredentialCachePath: "/workspace-runtime/.agent-runtime-auth.json",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        readFileImpl: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({
              env: {
                OPENAI_API_KEY: "sk-legacy-agent",
              },
            })
          ) as never,
        now: new Date("2026-04-22T11:00:00.000Z"),
      }
    );

    expect(env).toEqual({
      OPENAI_API_KEY: "sk-legacy-agent",
      CODEX_HOME: "/tmp/workspace-123/.codex-agent",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the broker returns an empty credential env", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          env: {},
        }),
        { status: 200 }
      )
    );

    await expect(
      resolveAgentRuntimeEnvironment(
        {
          workingDirectory: "/tmp/workspace-123",
          agentCredentialBrokerUrl:
            "http://host.docker.internal:3000/api/workspaces/workspace-123/agent-credentials",
          agentCredentialBrokerSecret: "runtime-secret",
        },
        {
          fetchImpl: fetchImpl as typeof fetch,
        }
      )
    ).rejects.toThrow(AgentRuntimeResolutionError);
  });

  it("fails cleanly when the broker cannot resolve the credential", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error:
            "A ready platform-default agent credential must be configured before this project can run.",
        }),
        { status: 503 }
      )
    );

    await expect(
      resolveAgentRuntimeEnvironment(
        {
          workingDirectory: "/tmp/workspace-123",
          agentCredentialBrokerUrl:
            "http://host.docker.internal:3000/api/workspaces/workspace-123/agent-credentials",
          agentCredentialBrokerSecret: "runtime-secret",
        },
        {
          fetchImpl: fetchImpl as typeof fetch,
        }
      )
    ).rejects.toThrow(AgentRuntimeResolutionError);
  });
});

describe("normalizeCodexRuntimeEvents", () => {
  it("maps a completion payload to neutral events", () => {
    const events = normalizeCodexRuntimeEvents({
      method: CODEX_PROTOCOL_EVENT_NAMES.turnCompleted,
      params: {
        inputRequired: false,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
        },
        rate_limits: {
          remaining: 10,
        },
      },
    });

    expect(events.map((event) => event.name)).toEqual([
      "agent.tokenUsageUpdated",
      "agent.rateLimit",
      "agent.turnCompleted",
    ]);
    expect(getCodexObservabilityEventName(events[2]!)).toBe(
      CODEX_PROTOCOL_EVENT_NAMES.turnCompleted
    );
    expect(events[2]).toMatchObject({
      name: "agent.turnCompleted",
      payload: {
        inputRequired: false,
      },
    });
  });

  it("recognizes canonical message delta and wrapped rate-limit payloads", () => {
    const messageDeltaEvents = normalizeCodexRuntimeEvents({
      method: CODEX_PROTOCOL_EVENT_NAMES.messageDelta,
      params: {
        item_id: "item-1",
        delta: "hello",
      },
    });
    const completionEvents = normalizeCodexRuntimeEvents({
      method: CODEX_PROTOCOL_EVENT_NAMES.turnCompleted,
      params: {
        result: {
          rate_limits: {
            remaining: 3,
            reset_at: "2026-04-23T15:00:00Z",
          },
        },
      },
    });

    expect(messageDeltaEvents).toEqual([
      {
        name: "agent.messageDelta",
        payload: {
          observabilityEvent: CODEX_PROTOCOL_EVENT_NAMES.messageDelta,
          params: {
            item_id: "item-1",
            delta: "hello",
          },
          delta: "hello",
          itemId: "item-1",
        },
      },
    ]);
    expect(completionEvents.map((event) => event.name)).toEqual([
      "agent.rateLimit",
      "agent.turnCompleted",
    ]);
    expect(completionEvents[0]).toMatchObject({
      name: "agent.rateLimit",
      payload: {
        observabilityEvent: CODEX_PROTOCOL_EVENT_NAMES.turnCompleted,
        params: {
          result: {
            rate_limits: {
              remaining: 3,
              reset_at: "2026-04-23T15:00:00Z",
            },
          },
        },
      },
    });
  });

  it("maps tool calls and input-required events to neutral names", () => {
    expect(
      normalizeCodexRuntimeEvents({
        method: CODEX_PROTOCOL_EVENT_NAMES.toolCallRequested,
        params: {
          callId: "call-1",
          tool: "github_graphql",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: { query: "{ viewer { login } }" },
        },
      })
    ).toEqual([
      {
        name: "agent.toolCallRequested",
        payload: {
          observabilityEvent: CODEX_PROTOCOL_EVENT_NAMES.toolCallRequested,
          params: {
            callId: "call-1",
            tool: "github_graphql",
            threadId: "thread-1",
            turnId: "turn-1",
            arguments: { query: "{ viewer { login } }" },
          },
          callId: "call-1",
          toolName: "github_graphql",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: { query: "{ viewer { login } }" },
        },
      },
    ]);

    expect(
      normalizeCodexRuntimeEvents({
        method: CODEX_PROTOCOL_EVENT_NAMES.inputRequired,
        params: { prompt: "Need approval" },
      })
    ).toEqual([
      {
        name: "agent.inputRequired",
        payload: {
          observabilityEvent: CODEX_PROTOCOL_EVENT_NAMES.inputRequired,
          params: { prompt: "Need approval" },
          reason: "turn_input_required: agent requires user input",
        },
      },
    ]);
  });
});

describe("prepareCodexRuntimePlan", () => {
  it("assembles the runtime environment after resolving agent credentials", async () => {
    const plan = await prepareCodexRuntimePlan(
      {
        projectId: "workspace-123",
        workingDirectory: "/tmp/workspace-123",
        githubTokenBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
        githubTokenBrokerSecret: "runtime-secret",
        agentCredentialBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-123/agent-credentials",
        agentCredentialBrokerSecret: "runtime-secret",
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              env: {
                OPENAI_API_KEY: "sk-plan-agent",
              },
              expires_at: "2026-04-22T10:10:00.000Z",
            }),
            { status: 200 }
          )
        ) as unknown as Promise<Response> as unknown as typeof fetch,
      }
    );

    expect(plan.env.OPENAI_API_KEY).toBe("sk-plan-agent");
    expect(plan.env.CODEX_HOME).toBe("/tmp/workspace-123/.codex-agent");
  });
});

describe("createCodexRuntimeAdapter", () => {
  it("implements the adapter prepare -> spawnTurn -> shutdown flow", async () => {
    const spawnImpl = vi.fn().mockReturnValue({
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    const adapter = createCodexRuntimeAdapter(
      {
        projectId: "workspace-123",
        workingDirectory: "/tmp/workspace-123",
        agentEnv: {
          OPENAI_API_KEY: "sk-direct-runtime",
        },
      },
      {
        mkdirImpl: vi.fn().mockResolvedValue(undefined),
        writeFileImpl: vi.fn().mockResolvedValue(undefined),
        copyFileImpl: vi.fn().mockResolvedValue(undefined),
        spawnImpl,
      }
    );

    await adapter.prepare();
    const result = await adapter.spawnTurn();

    expect(result.plan.env.OPENAI_API_KEY).toBe("sk-direct-runtime");
    expect(result.plan.env.CODEX_HOME).toBe(resolveStagedCodexHome("/tmp/workspace-123"));
    expect(spawnImpl).toHaveBeenCalledOnce();

    await adapter.shutdown();
    expect(result.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("terminates the running child when cancel() is invoked", async () => {
    const kill = vi.fn();
    const spawnImpl = vi.fn().mockReturnValue({
      pid: 99,
      exitCode: null,
      signalCode: null,
      kill,
    });
    const adapter = createCodexRuntimeAdapter(
      {
        projectId: "workspace-cancel",
        workingDirectory: "/tmp/workspace-cancel",
        agentEnv: {
          OPENAI_API_KEY: "sk-cancel",
        },
      },
      {
        mkdirImpl: vi.fn().mockResolvedValue(undefined),
        writeFileImpl: vi.fn().mockResolvedValue(undefined),
        copyFileImpl: vi.fn().mockResolvedValue(undefined),
        spawnImpl,
      }
    );

    await adapter.prepare();
    await adapter.spawnTurn();
    await adapter.cancel("operator-requested");
    await adapter.cancel("already-stopped");

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});

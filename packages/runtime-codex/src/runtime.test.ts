import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES,
  CUSTOM_RUNTIME_RESERVED_AUTH_ENVIRONMENT_NAMES,
} from "@gh-symphony/core";
import {
  AgentRuntimeResolutionError,
  CODEX_PROTOCOL_EVENT_NAMES,
  buildCodexRuntimePlan,
  createCodexDynamicToolSpecs,
  createCodexRuntimeAdapter,
  createGitCredentialHelperEnvironment,
  createGitHubGraphQLToolDefinition,
  createLinearGraphQLToolDefinition,
  getCodexObservabilityEventName,
  normalizeCodexRuntimeEvents,
  prepareCodexRuntimePlan,
  parseAgentCommand,
  resolvePreparedAgentEnvironment,
  resolveAgentRuntimeEnvironment,
  launchCodexAppServer,
} from "./runtime.js";

const originalCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
});

describe("createGitHubGraphQLToolDefinition", () => {
  it("builds a runtime tool definition for brokered GitHub GraphQL access", () => {
    const tool = createGitHubGraphQLToolDefinition({
      githubTokenBrokerUrl:
        "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-token.json",
      trackerSecretEnvironmentNames: [
        "GH_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_TOKEN",
        "GITHUB_GRAPHQL_TOKEN",
      ],
      githubProjectId: "project-123",
    });

    expect(tool.name).toBe("github_graphql");
    expect(tool.command).toBe("node");
    expect(tool.args[0]).toContain("mcp-server.js");
    expect(tool.env).toEqual({
      GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
      GITHUB_TOKEN_BROKER_URL:
        "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
      GITHUB_TOKEN_BROKER_SECRET: "runtime-secret",
      GITHUB_TOKEN_CACHE_PATH: "/workspace-runtime/.github-token.json",
      GITHUB_PROJECT_ID: "project-123",
    });
  });
});

describe("createLinearGraphQLToolDefinition", () => {
  it("builds a runtime tool definition for Linear GraphQL access", () => {
    const tool = createLinearGraphQLToolDefinition({
      linearGraphqlUrl: "https://api.linear.app/graphql",
      linearAuthorization: "Bearer runtime-token",
      linearApiKey: "lin_api_key",
    });

    expect(tool.name).toBe("linear_graphql");
    expect(tool.command).toBe("node");
    expect(tool.args[0]).toContain("mcp-server.js");
    expect(tool.env).toEqual({
      LINEAR_GRAPHQL_URL: "https://api.linear.app/graphql",
      LINEAR_AUTHORIZATION: "Bearer runtime-token",
      LINEAR_API_KEY: "lin_api_key",
    });
  });
});

describe("createCodexDynamicToolSpecs", () => {
  it("advertises schemas without process or credential details", () => {
    const specs = createCodexDynamicToolSpecs([
      createGitHubGraphQLToolDefinition({ githubToken: "host-secret" }),
    ]);

    expect(specs).toEqual([
      expect.objectContaining({
        type: "function",
        name: "github_graphql",
        inputSchema: expect.objectContaining({ required: ["query"] }),
      }),
    ]);
    expect(specs[0]).not.toHaveProperty("command");
    expect(specs[0]).not.toHaveProperty("env");
  });

  it("takes a stable copy of the startup tool definitions", () => {
    const tools = [createGitHubGraphQLToolDefinition({})];
    const specs = createCodexDynamicToolSpecs(tools);
    tools[0]!.name = "changed_after_startup";

    expect(specs[0]?.name).toBe("github_graphql");
  });
});

describe("buildCodexRuntimePlan", () => {
  it("strips tracker credentials from the adapter declaration", () => {
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      trackerSecretEnvironmentNames: ["TRACKER_ADAPTER_SECRET"],
      extraEnv: {
        TRACKER_ADAPTER_SECRET: "secret",
        UNDECLARED_TRACKER_VALUE: "visible",
      },
    });

    expect(plan.env.TRACKER_ADAPTER_SECRET).toBeUndefined();
    expect(plan.env.UNDECLARED_TRACKER_VALUE).toBe("visible");
  });

  it("strips every declared credential name at the agent-child boundary", () => {
    const injectedCredentials = Object.fromEntries(
      AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES.map((name) => [name, "secret"])
    );
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      extraEnv: injectedCredentials,
      agentEnv: { OPENAI_API_KEY: "sk-ready-runtime" },
    });

    for (const name of AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES) {
      expect(plan.env[name], name).toBeUndefined();
    }
  });

  it("prepares the codex app-server launch contract", () => {
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      githubToken: "raw-github-token",
      githubTokenBrokerUrl:
        "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-token.json",
      githubProjectId: "project-123",
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
      extraEnv: {
        WORKER_PROFILE: "test",
        SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
        SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
      },
    });

    expect(plan.command).toBe("codex");
    expect(plan.args).toEqual(["app-server"]);
    expect(plan.cwd).toBe("/tmp/workspace-123");
    expect(plan.tools).toEqual([]);
    expect(plan.dynamicTools).toEqual([
      expect.objectContaining({ name: "github_graphql", type: "function" }),
    ]);
    expect(plan.env.CODEX_PROJECT_ID).toBe("workspace-123");
    expect(plan.env.GITHUB_GRAPHQL_TOOL_NAME).toBeUndefined();
    expect(plan.env.GITHUB_GRAPHQL_TOOL_COMMAND).toBeUndefined();
    expect(plan.env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(plan.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(plan.env.WORKER_PROFILE).toBe("test");
    expect(plan.env.SYMPHONY_ASSIGNED_BRANCH).toBe("symphony/acme-42");
    expect(plan.env.SYMPHONY_ISSUE_IDENTIFIER).toBe("acme/repo#42");
    expect(plan.env.OPENAI_API_KEY).toBe("sk-ready-runtime");
    expect(plan.env.CODEX_HOME).toBe(
      "/tmp/workspace-123/.runtime/child-home/.codex"
    );
    expect(plan.env.GITHUB_GRAPHQL_TOKEN).toBeUndefined();
    expect(plan.env.GITHUB_TOKEN).toBeUndefined();
    expect(plan.env.GH_TOKEN).toBeUndefined();
    expect(plan.env.GITHUB_TOKEN_BROKER_SECRET).toBeUndefined();
  });

  it("isolates the agent from host Git credentials and native MCP subprocesses", () => {
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      githubToken: "raw-github-token",
      githubTokenBrokerUrl:
        "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "broker-secret",
      enableLinearGraphqlTool: true,
      linearApiKey: "lin-api-key",
      linearAuthorization: "Bearer lin-authorization",
      trackerSecretEnvironmentNames: [
        "GITHUB_GRAPHQL_TOKEN",
        "GITHUB_TOKEN_BROKER_SECRET",
        "LINEAR_API_KEY",
        "LINEAR_AUTHORIZATION",
      ],
      extraEnv: {
        HOME: "/Users/operator",
        GH_CONFIG_DIR: "/Users/operator/.config/gh",
        DOCKER_CONFIG: "/Users/operator/.docker",
        WORKSPACE_RUNTIME_DIR: "/tmp/runtime-123",
        GITHUB_TOKEN_BROKER_URL: "https://broker.example/token",
        GITHUB_TOKEN_CACHE_PATH: "/tmp/runtime-123/github-token.json",
        SSH_AUTH_SOCK: "/tmp/operator-ssh-agent.sock",
        GIT_ASKPASS: "/tmp/operator-git-askpass",
        SSH_ASKPASS: "/tmp/operator-ssh-askpass",
        GIT_CONFIG_GLOBAL: "/tmp/operator.gitconfig",
        XDG_CONFIG_HOME: "/tmp/operator-config",
      },
    });

    expect(plan.dynamicTools.map((tool) => tool.name)).toEqual([
      "github_graphql",
      "linear_graphql",
    ]);
    expect(plan.tools).toEqual([]);
    expect(plan.env).toMatchObject({
      HOME: "/tmp/runtime-123/child-home",
      USERPROFILE: "/tmp/runtime-123/child-home",
      GH_CONFIG_DIR: "/tmp/runtime-123/child-home/gh",
      CODEX_HOME: "/tmp/runtime-123/child-home/.codex",
      DOCKER_CONFIG: "/tmp/runtime-123/child-home/.docker",
    });
    expect(plan.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(plan.env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(plan.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(plan.env.GITHUB_GRAPHQL_TOKEN).toBeUndefined();
    expect(plan.env.GITHUB_TOKEN_BROKER_URL).toBeUndefined();
    expect(plan.env.GITHUB_TOKEN_BROKER_SECRET).toBeUndefined();
    expect(plan.env.GITHUB_TOKEN_CACHE_PATH).toBeUndefined();
    expect(plan.env.LINEAR_API_KEY).toBeUndefined();
    expect(plan.env.LINEAR_AUTHORIZATION).toBeUndefined();
    expect(plan.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(plan.env.GIT_ASKPASS).toBeUndefined();
    expect(plan.env.SSH_ASKPASS).toBeUndefined();
    expect(plan.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(plan.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(plan.env.DOCKER_CONFIG).toBe("/tmp/runtime-123/child-home/.docker");
  });

  it("removes direct Git credentials without a broker", () => {
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      githubToken: "raw-github-token",
      trackerSecretEnvironmentNames: ["GITHUB_GRAPHQL_TOKEN"],
    });

    expect(plan.env.GITHUB_GRAPHQL_TOKEN).toBeUndefined();
    expect(plan.tools).toEqual([]);
  });

  it("uses an isolated CODEX_HOME when a host source is explicitly provided", () => {
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
      extraEnv: {
        CODEX_HOME: "/tmp/local-codex-home",
      },
    });

    expect(plan.env.CODEX_HOME).toBe(
      "/tmp/workspace-123/.runtime/child-home/.codex"
    );
  });

  it("does not expose process CODEX_HOME to the child", () => {
    process.env.CODEX_HOME = "/tmp/process-codex-home";

    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
    });

    expect(plan.env.CODEX_HOME).toBe(
      "/tmp/workspace-123/.runtime/child-home/.codex"
    );
  });

  it("does not inherit unallowlisted process env secrets", () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "ghs_secret";

    try {
      const plan = buildCodexRuntimePlan({
        projectId: "workspace-123",
        workingDirectory: "/tmp/workspace-123",
        agentEnv: {
          OPENAI_API_KEY: "sk-ready-runtime",
        },
      });

      expect(plan.env.GITHUB_GRAPHQL_TOKEN).toBeUndefined();
    } finally {
      delete process.env.GITHUB_GRAPHQL_TOKEN;
    }
  });

  it("advertises builtin schemas dynamically without exposing sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-mcp-sidecar-"));
    const workspace = join(root, "workspace");
    const project = join(root, "project");
    await Promise.all([mkdir(workspace), mkdir(project)]);
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          vendor_api: {
            command: "vendor-mcp",
            args: ["--serve"],
            env: { VENDOR_SECRET: "$MCP_VENDOR_SECRET" },
          },
          github_graphql: { command: "replacement" },
        },
      })
    );
    process.env.MCP_VENDOR_SECRET = "vendor-secret";
    try {
      const plan = buildCodexRuntimePlan({
        projectId: "workspace-123",
        workingDirectory: workspace,
        projectDirectory: project,
        extraEnv: { CODEX_HOME: "/tmp/codex" },
      });
      expect(plan.dynamicTools[0]?.inputSchema.properties).toHaveProperty(
        "query"
      );
      expect(plan.tools).toEqual([]);
      expect(plan.env.VENDOR_SECRET).toBeUndefined();
    } finally {
      delete process.env.MCP_VENDOR_SECRET;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes indirect tracker credentials from brokered tool definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-mcp-tracker-secret-"));
    const workspace = join(root, "workspace");
    const project = join(root, "project");
    await Promise.all([mkdir(workspace), mkdir(project)]);
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          org_github: {
            command: "node",
            env: {
              GITHUB_GRAPHQL_TOKEN: "$MY_ORG_PAT",
              CUSTOM_TOKEN: "$GITHUB_GRAPHQL_TOKEN",
            },
          },
        },
      })
    );
    process.env.MY_ORG_PAT = "indirect-github-secret";
    try {
      const plan = buildCodexRuntimePlan({
        projectId: "workspace-123",
        workingDirectory: workspace,
        projectDirectory: project,
        githubToken: "raw-github-token",
        extraEnv: { GITHUB_GRAPHQL_TOKEN: "raw-github-token" },
        githubTokenBrokerUrl: "https://broker.example/runtime-credentials",
        githubTokenBrokerSecret: "broker-secret",
        trackerSecretEnvironmentNames: ["GITHUB_GRAPHQL_TOKEN"],
      });
      expect(JSON.stringify(plan.tools)).not.toContain(
        "indirect-github-secret"
      );
      expect(JSON.stringify(plan.tools)).not.toContain("raw-github-token");
      expect(plan.env.MY_ORG_PAT).toBeUndefined();
    } finally {
      delete process.env.MY_ORG_PAT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards run-scoped orchestrator context to the agent environment", () => {
    const plan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      orchestratorUrl: "http://127.0.0.1:4680",
      orchestratorRunId: "run-abc",
      orchestratorToken: "token-secret",
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
    });

    expect(plan.env.SYMPHONY_ORCHESTRATOR_URL).toBe("http://127.0.0.1:4680");
    expect(plan.env.SYMPHONY_RUN_ID).toBe("run-abc");
    expect(plan.env.SYMPHONY_ORCHESTRATOR_TOKEN).toBe("token-secret");
  });

  it("omits run-scoped orchestrator context when it is absent or empty", () => {
    process.env.SYMPHONY_ORCHESTRATOR_TOKEN = "process-secret";

    try {
      const plan = buildCodexRuntimePlan({
        projectId: "workspace-123",
        workingDirectory: "/tmp/workspace-123",
        orchestratorUrl: "",
        orchestratorRunId: "",
        orchestratorToken: "",
        agentEnv: {
          OPENAI_API_KEY: "sk-ready-runtime",
        },
      });

      expect(plan.env.SYMPHONY_ORCHESTRATOR_URL).toBeUndefined();
      expect(plan.env.SYMPHONY_RUN_ID).toBeUndefined();
      expect(plan.env.SYMPHONY_ORCHESTRATOR_TOKEN).toBeUndefined();
    } finally {
      delete process.env.SYMPHONY_ORCHESTRATOR_TOKEN;
    }
  });

  it("advertises linear_graphql dynamically only for Linear sessions", () => {
    const nonLinearPlan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
    });
    expect(nonLinearPlan.dynamicTools.map((tool) => tool.name)).toEqual([
      "github_graphql",
    ]);
    expect(nonLinearPlan.env.LINEAR_GRAPHQL_TOOL_NAME).toBeUndefined();
    expect(nonLinearPlan.env.LINEAR_GRAPHQL_URL).toBeUndefined();
    expect(nonLinearPlan.env.LINEAR_API_KEY).toBeUndefined();
    expect(nonLinearPlan.env.LINEAR_AUTHORIZATION).toBeUndefined();

    const nonLinearPlanWithLinearSecret = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      linearApiKey: "lin_api_key",
      linearAuthorization: "Bearer lin_api_key",
      linearGraphqlUrl: "https://api.linear.app/graphql",
      extraEnv: {
        LINEAR_API_KEY: "global-lin-api-key",
        LINEAR_AUTHORIZATION: "Bearer global-lin-api-key",
        LINEAR_GRAPHQL_URL: "https://preview.linear.app/graphql",
      },
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
    });
    expect(
      nonLinearPlanWithLinearSecret.env.LINEAR_GRAPHQL_TOOL_NAME
    ).toBeUndefined();
    expect(
      nonLinearPlanWithLinearSecret.env.LINEAR_GRAPHQL_URL
    ).toBeUndefined();
    expect(nonLinearPlanWithLinearSecret.env.LINEAR_API_KEY).toBeUndefined();
    expect(
      nonLinearPlanWithLinearSecret.env.LINEAR_AUTHORIZATION
    ).toBeUndefined();

    const linearPlan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      enableLinearGraphqlTool: true,
      linearApiKey: "lin_api_key",
      linearGraphqlUrl: "https://api.linear.app/graphql",
      agentEnv: {
        OPENAI_API_KEY: "sk-ready-runtime",
      },
    });

    expect(linearPlan.dynamicTools.map((tool) => tool.name)).toEqual([
      "github_graphql",
      "linear_graphql",
    ]);
    expect(linearPlan.env.LINEAR_GRAPHQL_TOOL_NAME).toBeUndefined();
    expect(linearPlan.env.LINEAR_GRAPHQL_URL).toBeUndefined();
    expect(linearPlan.env.LINEAR_API_KEY).toBeUndefined();
    expect(linearPlan.tools).toEqual([]);

    const brokeredLinearPlan = buildCodexRuntimePlan({
      projectId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      trackerKind: "linear",
      enableLinearGraphqlTool: true,
      linearApiKey: "lin_api_key",
      githubTokenBrokerUrl: "https://broker.example/runtime-credentials",
      githubTokenBrokerSecret: "broker-secret",
      trackerSecretEnvironmentNames: ["LINEAR_API_KEY"],
    });
    expect(brokeredLinearPlan.env.LINEAR_API_KEY).toBeUndefined();
  });
});

describe("resolvePreparedAgentEnvironment", () => {
  it("filters direct agent env keys without staging CODEX_HOME", () => {
    expect(
      resolvePreparedAgentEnvironment({
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "https://example.test/v1",
        UNRELATED: "ignored",
      })
    ).toEqual({
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://example.test/v1",
    });
  });
});

describe("parseAgentCommand", () => {
  it("parses codex agentCommand into argv without shell wrapping", () => {
    expect(parseAgentCommand("codex app-server --model gpt-5")).toEqual({
      command: "codex",
      args: ["app-server", "--model", "gpt-5"],
    });
  });

  it("rejects shell metacharacters in agentCommand", () => {
    expect(() => parseAgentCommand("codex; curl attacker")).toThrow(
      AgentRuntimeResolutionError
    );
  });

  it("rejects non-allowlisted agentCommand executables", () => {
    expect(() => parseAgentCommand("node worker.js")).toThrow(
      AgentRuntimeResolutionError
    );
  });
});

describe("createGitCredentialHelperEnvironment", () => {
  it("classifies every injected credential name for child stripping", () => {
    const injected = Object.keys(
      createGitCredentialHelperEnvironment({
        githubToken: "host-token",
        githubTokenBrokerUrl:
          "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
        githubTokenBrokerSecret: "runtime-secret",
        githubTokenCachePath: "/workspace-runtime/.github-token.json",
        tokenBrokerTimeoutMs: 1_000,
      })
    ).filter(
      (name) =>
        name !== "GIT_TERMINAL_PROMPT" &&
        name !== "GITHUB_TOKEN_BROKER_TIMEOUT_MS"
    );

    const covered = injected.filter(
      (name) =>
        AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES.includes(
          name as (typeof AGENT_CHILD_CREDENTIAL_ENVIRONMENT_NAMES)[number]
        ) ||
        CUSTOM_RUNTIME_RESERVED_AUTH_ENVIRONMENT_NAMES.includes(
          name as (typeof CUSTOM_RUNTIME_RESERVED_AUTH_ENVIRONMENT_NAMES)[number]
        ) ||
        /^GIT_CONFIG_(KEY|VALUE)_/.test(name)
    );

    expect(covered).toEqual(injected);
  });

  it("configures git to use a renewable credential helper", () => {
    const env = createGitCredentialHelperEnvironment({
      githubTokenBrokerUrl:
        "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-token.json",
      tokenBrokerTimeoutMs: 7_500,
    });

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("git-credential-helper.js");
    expect(env.GITHUB_GIT_HOST).toBe("github.com");
    expect(env.GITHUB_GIT_USERNAME).toBe("x-access-token");
    expect(env.GITHUB_TOKEN_BROKER_URL).toContain("/runtime-credentials");
    expect(env.GITHUB_TOKEN_BROKER_TIMEOUT_MS).toBe("7500");
  });

  it("preserves a configured Git host and username for the helper", () => {
    const env = createGitCredentialHelperEnvironment({
      githubToken: "host-token",
      gitHost: "github.enterprise.example",
      gitUsername: "symphony-service",
    });

    expect(env.GITHUB_GIT_HOST).toBe("github.enterprise.example");
    expect(env.GITHUB_GIT_USERNAME).toBe("symphony-service");
  });

  it("rejects non-https broker URLs before exposing them to git", () => {
    expect(() =>
      createGitCredentialHelperEnvironment({
        githubTokenBrokerUrl: "http://broker.example/runtime-credentials",
        githubTokenBrokerSecret: "runtime-secret",
      })
    ).toThrow(/must use https/);
  });

  it("rejects an invalid broker timeout before exposing it to git", () => {
    expect(() =>
      createGitCredentialHelperEnvironment({
        githubTokenBrokerUrl: "https://broker.example/runtime-credentials",
        githubTokenBrokerSecret: "runtime-secret",
        tokenBrokerTimeoutMs: 0,
      })
    ).toThrow(/GITHUB_TOKEN_BROKER_TIMEOUT_MS must be a positive integer/);
  });

  it.each(["", "  "])(
    "omits an unset broker timeout %j from the helper environment",
    (tokenBrokerTimeoutMs) => {
      const env = createGitCredentialHelperEnvironment({
        githubToken: "host-token",
        tokenBrokerTimeoutMs,
      });

      expect(env).not.toHaveProperty("GITHUB_TOKEN_BROKER_TIMEOUT_MS");
    }
  );
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
        "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
    });

    const child = launchCodexAppServer(plan, spawnImpl);

    expect(spawnImpl).toHaveBeenCalledWith("codex", ["app-server"], {
      cwd: "/tmp/workspace-123",
      env: plan.env,
      stdio: "pipe",
    });
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
        readFileImpl: vi.fn().mockResolvedValue(
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
        readFileImpl: vi.fn().mockResolvedValue(
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
        readFileImpl: vi.fn().mockResolvedValue(
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

  it("does not treat unrelated nested quota payloads as rate-limit events", () => {
    const events = normalizeCodexRuntimeEvents({
      method: CODEX_PROTOCOL_EVENT_NAMES.turnCompleted,
      params: {
        result: {
          quota: {
            remaining: 3,
          },
        },
      },
    });

    expect(events).toEqual([
      {
        name: "agent.turnCompleted",
        payload: {
          observabilityEvent: CODEX_PROTOCOL_EVENT_NAMES.turnCompleted,
          params: {
            result: {
              quota: {
                remaining: 3,
              },
            },
          },
          inputRequired: false,
        },
      },
    ]);
  });

  it("does not treat generic data wrappers as rate-limit events", () => {
    const events = normalizeCodexRuntimeEvents({
      method: CODEX_PROTOCOL_EVENT_NAMES.turnCompleted,
      params: {
        data: {
          remaining: 3,
        },
      },
    });

    expect(events).toEqual([
      {
        name: "agent.turnCompleted",
        payload: {
          observabilityEvent: CODEX_PROTOCOL_EVENT_NAMES.turnCompleted,
          params: {
            data: {
              remaining: 3,
            },
          },
          inputRequired: false,
        },
      },
    ]);
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
        params: { prompt: "  Need approval  " },
      })
    ).toEqual([
      {
        name: "agent.inputRequired",
        payload: {
          observabilityEvent: CODEX_PROTOCOL_EVENT_NAMES.inputRequired,
          params: { prompt: "  Need approval  " },
          reason: "turn_input_required: Need approval",
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
          "https://broker.example/api/workspaces/workspace-123/runtime-credentials",
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
    expect(plan.env.CODEX_HOME).toBe(
      "/tmp/workspace-123/.runtime/child-home/.codex"
    );
  });
});

describe("createCodexRuntimeAdapter", () => {
  it("stages only Codex provider auth into the isolated child home", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-child-auth-"));
    const hostHome = join(root, "host-home");
    const hostCodexHome = join(hostHome, ".codex");
    const runtimeDirectory = join(root, "runtime");
    const workspace = join(root, "workspace");
    await Promise.all([
      mkdir(hostCodexHome, { recursive: true }),
      mkdir(workspace),
    ]);
    await writeFile(
      join(hostCodexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "provider" },
      })
    );
    await writeFile(
      join(hostCodexHome, "config.toml"),
      "[mcp_servers.github]\n"
    );
    await writeFile(
      join(hostHome, ".gitconfig"),
      "[user]\n\tname = Symphony Operator\n\temail = operator@example.test\n[credential]\n\thelper = host-only-helper\n"
    );

    try {
      const adapter = createCodexRuntimeAdapter(
        {
          projectId: "workspace-auth",
          workingDirectory: workspace,
          extraEnv: {
            HOME: hostHome,
            WORKSPACE_RUNTIME_DIR: runtimeDirectory,
          },
        },
        {
          spawnImpl: vi.fn().mockReturnValue({
            pid: 42,
            exitCode: null,
            signalCode: null,
            kill: vi.fn(),
          }),
        }
      );

      await adapter.prepare();
      const result = await adapter.spawnTurn();
      const childCodexHome = join(runtimeDirectory, "child-home", ".codex");

      expect(
        JSON.parse(await readFile(join(childCodexHome, "auth.json"), "utf8"))
      ).toEqual({
        auth_mode: "chatgpt",
        tokens: { access_token: "provider" },
      });
      await expect(
        readFile(join(childCodexHome, "config.toml"), "utf8")
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(runtimeDirectory, "child-home", ".gitconfig"), "utf8")
      ).resolves.toBe(
        "[user]\n\tname = Symphony Operator\n\temail = operator@example.test\n"
      );
      expect(
        (await stat(join(runtimeDirectory, "child-home"))).mode & 0o777
      ).toBe(0o700);
      expect(
        (await stat(join(runtimeDirectory, "child-home", "gh"))).mode & 0o777
      ).toBe(0o700);
      await adapter.shutdown();
      expect(result.plan.env.CODEX_HOME).toBe(childCodexHome);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
        spawnImpl,
      }
    );

    await adapter.prepare();
    const result = await adapter.spawnTurn();

    expect(result.plan.env.OPENAI_API_KEY).toBe("sk-direct-runtime");
    expect(result.plan.env.CODEX_HOME).toBe(
      "/tmp/workspace-123/.runtime/child-home/.codex"
    );
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

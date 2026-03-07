import { describe, expect, it, vi } from "vitest";
import {
  buildCodexRuntimePlan,
  createGitCredentialHelperEnvironment,
  createGitHubGraphQLToolDefinition,
  launchCodexAppServer
} from "./runtime.js";

describe("createGitHubGraphQLToolDefinition", () => {
  it("builds a runtime tool definition for brokered GitHub GraphQL access", () => {
    const tool = createGitHubGraphQLToolDefinition({
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-installation-token.json",
      githubProjectId: "project-123"
    });

    expect(tool.name).toBe("github_graphql");
    expect(tool.command).toBe("node");
    expect(tool.args[0]).toContain("github-graphql-tool.js");
    expect(tool.env).toEqual({
      GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
      GITHUB_TOKEN_BROKER_URL:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      GITHUB_TOKEN_BROKER_SECRET: "runtime-secret",
      GITHUB_TOKEN_CACHE_PATH: "/workspace-runtime/.github-installation-token.json",
      GITHUB_PROJECT_ID: "project-123"
    });
  });
});

describe("buildCodexRuntimePlan", () => {
  it("prepares the codex app-server launch contract", () => {
    const plan = buildCodexRuntimePlan({
      workspaceId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-installation-token.json",
      githubProjectId: "project-123",
      extraEnv: {
        WORKER_PROFILE: "test"
      }
    });

    expect(plan.command).toBe("bash");
    expect(plan.args).toEqual(["-lc", "codex app-server"]);
    expect(plan.cwd).toBe("/tmp/workspace-123");
    expect(plan.tools).toHaveLength(1);
    expect(plan.env.CODEX_WORKSPACE_ID).toBe("workspace-123");
    expect(plan.env.GITHUB_GRAPHQL_TOOL_NAME).toBe("github_graphql");
    expect(plan.env.GITHUB_GRAPHQL_TOOL_COMMAND).toContain("github-graphql-tool.js");
    expect(plan.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(plan.env.GIT_CONFIG_VALUE_0).toContain("git-credential-helper.js");
    expect(plan.env.WORKER_PROFILE).toBe("test");
  });
});

describe("createGitCredentialHelperEnvironment", () => {
  it("configures git to use a renewable credential helper", () => {
    const env = createGitCredentialHelperEnvironment({
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret",
      githubTokenCachePath: "/workspace-runtime/.github-installation-token.json"
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
      pid: 42
    });

    const plan = buildCodexRuntimePlan({
      workspaceId: "workspace-123",
      workingDirectory: "/tmp/workspace-123",
      githubTokenBrokerUrl:
        "http://host.docker.internal:3000/api/workspaces/workspace-123/runtime-credentials",
      githubTokenBrokerSecret: "runtime-secret"
    });

    const child = launchCodexAppServer(plan, spawnImpl);

    expect(spawnImpl).toHaveBeenCalledWith("bash", ["-lc", "codex app-server"], {
      cwd: "/tmp/workspace-123",
      env: plan.env,
      stdio: "pipe"
    });
    expect(child).toEqual({
      pid: 42
    });
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalRuntimeLauncherError,
  loadLauncherEnvironment,
  resolveLocalRuntimeLaunchConfig,
  runLocalRuntimeLauncher,
} from "./launcher.js";
import * as runtimeModule from "./runtime.js";
import { vi } from "vitest";

describe("resolveLocalRuntimeLaunchConfig", () => {
  it("builds a direct-launch config from environment variables", () => {
    const config = resolveLocalRuntimeLaunchConfig({
      PROJECT_ID: "workspace-local",
      WORKING_DIRECTORY: "/tmp/workspace-local",
      GITHUB_GRAPHQL_TOKEN: "ghp_direct_token",
      GITHUB_PROJECT_ID: "project-123",
      OPENAI_API_KEY: "sk-direct-runtime",
    });

    expect(config).toMatchObject({
      projectId: "workspace-local",
      workingDirectory: "/tmp/workspace-local",
      githubToken: "ghp_direct_token",
      githubProjectId: "project-123",
      agentEnv: {
        OPENAI_API_KEY: "sk-direct-runtime",
      },
    });
  });

  it("accepts CODEX_PROJECT_ID as a fallback identifier", () => {
    const config = resolveLocalRuntimeLaunchConfig({
      CODEX_PROJECT_ID: "workspace-fallback",
      WORKING_DIRECTORY: "/tmp/workspace-fallback",
      OPENAI_API_KEY: "sk-fallback-runtime",
    });

    expect(config.projectId).toBe("workspace-fallback");
  });

  it("preserves host and runtime paths for isolated credential staging", () => {
    const config = resolveLocalRuntimeLaunchConfig({
      PROJECT_ID: "workspace-local",
      WORKING_DIRECTORY: "/tmp/workspace-local",
      HOME: "/Users/operator",
      CODEX_HOME: "/tmp/launcher-codex-home",
      WORKSPACE_RUNTIME_DIR: "/tmp/runtime-run",
      SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
      GITHUB_TOKEN_BROKER_SECRET: "broker-secret",
      OPENAI_API_KEY: "sk-direct-runtime",
    });

    expect(config.extraEnv).toEqual({
      HOME: "/Users/operator",
      CODEX_HOME: "/tmp/launcher-codex-home",
      WORKSPACE_RUNTIME_DIR: "/tmp/runtime-run",
      SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
    });
    expect(config.agentEnv).toEqual({
      OPENAI_API_KEY: "sk-direct-runtime",
    });
  });

  it("carries run-scoped orchestrator context from the environment", () => {
    const config = resolveLocalRuntimeLaunchConfig({
      PROJECT_ID: "workspace-local",
      WORKING_DIRECTORY: "/tmp/workspace-local",
      SYMPHONY_ORCHESTRATOR_URL: "http://127.0.0.1:4680",
      SYMPHONY_RUN_ID: "run-abc",
      SYMPHONY_ORCHESTRATOR_TOKEN: "token-secret",
    });

    expect(config).toMatchObject({
      orchestratorUrl: "http://127.0.0.1:4680",
      orchestratorRunId: "run-abc",
      orchestratorToken: "token-secret",
    });
  });

  it("fails when the working directory is missing", () => {
    expect(() =>
      resolveLocalRuntimeLaunchConfig({
        PROJECT_ID: "workspace-missing-dir",
      })
    ).toThrow(LocalRuntimeLauncherError);
  });
});

describe("loadLauncherEnvironment", () => {
  it("keeps explicit environment values ahead of .env defaults", () => {
    const env = loadLauncherEnvironment({
      PROJECT_ID: "workspace-explicit",
    });

    expect(env.PROJECT_ID).toBe("workspace-explicit");
  });

  it("does not load a .env file from the process cwd", async () => {
    const cwd = process.cwd();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "launcher-env-"));
    await writeFile(
      join(temporaryDirectory, ".env"),
      "REPOSITORY_ROOT_SECRET=must-not-load\n",
      "utf8"
    );

    try {
      process.chdir(temporaryDirectory);

      const env = loadLauncherEnvironment({ PROJECT_ID: "workspace" });

      expect(env.REPOSITORY_ROOT_SECRET).toBeUndefined();
    } finally {
      process.chdir(cwd);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("runLocalRuntimeLauncher", () => {
  it("prints a launch summary before starting codex", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const launchSpy = vi
      .spyOn(runtimeModule, "launchCodexAppServer")
      .mockReturnValue({
        pid: 4242,
        stdout: null,
        stderr: null,
        once(event: string, handler: (...args: unknown[]) => void) {
          if (event === "exit") {
            handler(0, null);
          }

          return this;
        },
      } as never);
    vi.spyOn(runtimeModule, "prepareCodexRuntimePlan").mockResolvedValue({
      cwd: "/tmp/workspace-local",
      command: "bash",
      args: ["-lc", "codex app-server"],
      env: {},
      tools: [
        {
          name: "github_graphql",
          description: "GraphQL",
          command: "node",
          args: ["tool.js"],
          env: {},
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
    });

    await runLocalRuntimeLauncher({
      PROJECT_ID: "workspace-local",
      WORKING_DIRECTORY: "/tmp/workspace-local",
      GITHUB_PROJECT_ID: "project-123",
      GITHUB_GRAPHQL_TOKEN: "ghp_direct_token",
    });

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining("[worker] starting local codex runtime")
    );
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining(
        "[worker] note: codex app-server does not proactively read GitHub issues."
      )
    );

    stdoutWrite.mockRestore();
  });
});

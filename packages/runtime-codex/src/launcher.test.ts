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
      TENANT_ID: "workspace-local",
      WORKING_DIRECTORY: "/tmp/workspace-local",
      GITHUB_GRAPHQL_TOKEN: "ghp_direct_token",
      GITHUB_PROJECT_ID: "project-123",
      OPENAI_API_KEY: "sk-direct-runtime",
    });

    expect(config).toMatchObject({
      tenantId: "workspace-local",
      workingDirectory: "/tmp/workspace-local",
      githubToken: "ghp_direct_token",
      githubProjectId: "project-123",
      agentEnv: {
        OPENAI_API_KEY: "sk-direct-runtime",
      },
    });
  });

  it("accepts CODEX_TENANT_ID as a fallback identifier", () => {
    const config = resolveLocalRuntimeLaunchConfig({
      CODEX_TENANT_ID: "workspace-fallback",
      WORKING_DIRECTORY: "/tmp/workspace-fallback",
      OPENAI_API_KEY: "sk-fallback-runtime",
    });

    expect(config.tenantId).toBe("workspace-fallback");
  });

  it("fails when the working directory is missing", () => {
    expect(() =>
      resolveLocalRuntimeLaunchConfig({
        TENANT_ID: "workspace-missing-dir",
      })
    ).toThrow(LocalRuntimeLauncherError);
  });
});

describe("loadLauncherEnvironment", () => {
  it("keeps explicit environment values ahead of .env defaults", () => {
    const env = loadLauncherEnvironment(
      {
        TENANT_ID: "workspace-explicit",
      },
      "/tmp/does-not-exist"
    );

    expect(env.TENANT_ID).toBe("workspace-explicit");
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
      TENANT_ID: "workspace-local",
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

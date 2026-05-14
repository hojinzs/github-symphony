import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { composeClaudeMcpConfig } from "./mcp-compose.js";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "claude-mcp-compose-"));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("composeClaudeMcpConfig", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, {
      force: true,
      recursive: true,
    })));
  });

  it("creates a runtime mcp config with only github_graphql when none exists", async () => {
    const workspaceRoot = await createTempWorkspace();
    const runtimeRoot = join(workspaceRoot, "runtime");

    const result = await composeClaudeMcpConfig(workspaceRoot, false, {
      GITHUB_GRAPHQL_TOKEN: "token-1",
      WORKSPACE_RUNTIME_DIR: runtimeRoot,
    });

    expect(result).toEqual({
      finalPath: join(runtimeRoot, "mcp.json"),
      extraArgv: ["--mcp-config", join(runtimeRoot, "mcp.json")],
      cleanupPath: join(runtimeRoot, "mcp.json"),
    });
    expect(await readJson(result.finalPath)).toEqual({
      mcpServers: {
        github_graphql: {
          command: "node",
          args: [expect.stringContaining("mcp-server.js")],
          env: {
            GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
            GITHUB_GRAPHQL_TOKEN: "token-1",
          },
        },
      },
    });
  });

  it("preserves user-authored keys and overwrites github_graphql", async () => {
    const workspaceRoot = await createTempWorkspace();
    const runtimeRoot = join(workspaceRoot, "runtime");
    const workspaceMcpPath = join(workspaceRoot, ".mcp.json");
    const originalConfig = JSON.stringify({
      customTopLevel: true,
      mcpServers: {
        user_server: {
          command: "node",
          args: ["user-server.js"],
        },
        github_graphql: {
          command: "old",
          env: {
            GITHUB_GRAPHQL_TOKEN: "old-token",
          },
        },
      },
    }, null, 2) + "\n";
    await writeFile(
      workspaceMcpPath,
      originalConfig,
      "utf8"
    );

    const result = await composeClaudeMcpConfig(workspaceRoot, false, {
      GITHUB_GRAPHQL_TOKEN: "token-2",
      GITHUB_PROJECT_ID: "project-1",
      WORKSPACE_RUNTIME_DIR: runtimeRoot,
    });

    expect(result).toEqual({
      finalPath: join(runtimeRoot, "mcp.json"),
      extraArgv: ["--mcp-config", join(runtimeRoot, "mcp.json")],
      cleanupPath: join(runtimeRoot, "mcp.json"),
    });
    expect(await readFile(workspaceMcpPath, "utf8")).toBe(originalConfig);
    expect(await readJson(result.finalPath)).toEqual({
      customTopLevel: true,
      mcpServers: {
        user_server: {
          command: "node",
          args: ["user-server.js"],
        },
        github_graphql: {
          command: "node",
          args: [expect.stringContaining("mcp-server.js")],
          env: {
            GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
            GITHUB_GRAPHQL_TOKEN: "token-2",
            GITHUB_PROJECT_ID: "project-1",
          },
        },
      },
    });
  });

  it("writes strict mode config to an ephemeral path without mutating the workspace file", async () => {
    const workspaceRoot = await createTempWorkspace();
    const runtimeRoot = join(workspaceRoot, "runtime-root");
    const workspaceMcpPath = join(workspaceRoot, ".mcp.json");
    const originalConfig = JSON.stringify({
      mcpServers: {
        user_server: {
          command: "node",
          args: ["user-server.js"],
        },
      },
    }, null, 2) + "\n";
    await writeFile(workspaceMcpPath, originalConfig, "utf8");

    const result = await composeClaudeMcpConfig(workspaceRoot, true, {
      GITHUB_GRAPHQL_TOKEN: "token-3",
      WORKSPACE_RUNTIME_DIR: runtimeRoot,
    });

    expect(result).toEqual({
      finalPath: join(runtimeRoot, "mcp.json"),
      extraArgv: [
        "--strict-mcp-config",
        "--mcp-config",
        join(runtimeRoot, "mcp.json"),
      ],
      cleanupPath: join(runtimeRoot, "mcp.json"),
    });
    expect(await readFile(workspaceMcpPath, "utf8")).toBe(originalConfig);
    expect(await readJson(result.finalPath)).toEqual({
      mcpServers: {
        user_server: {
          command: "node",
          args: ["user-server.js"],
        },
        github_graphql: {
          command: "node",
          args: [expect.stringContaining("mcp-server.js")],
          env: {
            GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
            GITHUB_GRAPHQL_TOKEN: "token-3",
          },
        },
      },
    });
  });

  it("throws when the workspace .mcp.json contains invalid JSON", async () => {
    const workspaceRoot = await createTempWorkspace();
    await writeFile(join(workspaceRoot, ".mcp.json"), "{ invalid", "utf8");

    await expect(
      composeClaudeMcpConfig(workspaceRoot, false, {})
    ).rejects.toThrow(SyntaxError);
  });

  it("treats a non-object mcpServers value as empty", async () => {
    const workspaceRoot = await createTempWorkspace();
    const runtimeRoot = join(workspaceRoot, "runtime");
    const workspaceMcpPath = join(workspaceRoot, ".mcp.json");
    const originalConfig = JSON.stringify({
      mcpServers: null,
    }) + "\n";
    await writeFile(
      workspaceMcpPath,
      originalConfig,
      "utf8"
    );

    const result = await composeClaudeMcpConfig(workspaceRoot, false, {
      WORKSPACE_RUNTIME_DIR: runtimeRoot,
    });

    expect(result.finalPath).toBe(join(runtimeRoot, "mcp.json"));
    expect(await readFile(workspaceMcpPath, "utf8")).toBe(originalConfig);
    expect(await readJson(result.finalPath)).toEqual({
      mcpServers: {
        github_graphql: {
          command: "node",
          args: [expect.stringContaining("mcp-server.js")],
          env: {
            GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
          },
        },
      },
    });
  });

  it("keeps an existing git workspace clean after non-strict preparation", async () => {
    const workspaceRoot = await createTempWorkspace();
    const runtimeRoot = await createTempWorkspace();
    const workspaceMcpPath = join(workspaceRoot, ".mcp.json");
    const userConfig = JSON.stringify({
      mcpServers: {
        user_server: {
          command: "node",
          args: ["user-server.js"],
        },
      },
    }, null, 2) + "\n";
    await writeFile(workspaceMcpPath, userConfig, "utf8");
    await execFileAsync("git", ["init"], { cwd: workspaceRoot });
    await execFileAsync("git", ["add", ".mcp.json"], { cwd: workspaceRoot });
    await execFileAsync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "initial",
      ],
      { cwd: workspaceRoot }
    );

    const result = await composeClaudeMcpConfig(workspaceRoot, false, {
      GITHUB_GRAPHQL_TOKEN: "token-clean",
      WORKSPACE_RUNTIME_DIR: runtimeRoot,
    });
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: workspaceRoot,
    });

    expect(stdout).toBe("");
    expect(await readFile(workspaceMcpPath, "utf8")).toBe(userConfig);
    expect(await readJson(result.finalPath)).toMatchObject({
      mcpServers: {
        user_server: {
          command: "node",
          args: ["user-server.js"],
        },
        github_graphql: {
          env: {
            GITHUB_GRAPHQL_TOKEN: "token-clean",
          },
        },
      },
    });
  });
});

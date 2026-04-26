import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { composeClaudeMcpConfig } from "./mcp-compose.js";

const tempRoots: string[] = [];

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

  it("creates a workspace .mcp.json with only github_graphql when none exists", async () => {
    const workspaceRoot = await createTempWorkspace();

    const result = await composeClaudeMcpConfig(workspaceRoot, false, {
      GITHUB_GRAPHQL_TOKEN: "token-1",
    });

    expect(result).toEqual({
      finalPath: join(workspaceRoot, ".mcp.json"),
      extraArgv: [],
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
    const workspaceMcpPath = join(workspaceRoot, ".mcp.json");
    await writeFile(
      workspaceMcpPath,
      JSON.stringify({
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
      }),
      "utf8"
    );

    const result = await composeClaudeMcpConfig(workspaceRoot, false, {
      GITHUB_GRAPHQL_TOKEN: "token-2",
      GITHUB_PROJECT_ID: "project-1",
    });

    expect(result.finalPath).toBe(workspaceMcpPath);
    expect(await readJson(workspaceMcpPath)).toEqual({
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
});

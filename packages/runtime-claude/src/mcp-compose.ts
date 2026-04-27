import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createGitHubGraphQLMcpServerEntry } from "@gh-symphony/tool-github-graphql";

export type ClaudeMcpTokenEnvironment = {
  GITHUB_GRAPHQL_TOKEN?: string;
  GITHUB_GRAPHQL_API_URL?: string;
  GITHUB_TOKEN_BROKER_URL?: string;
  GITHUB_TOKEN_BROKER_SECRET?: string;
  GITHUB_TOKEN_CACHE_PATH?: string;
  GITHUB_PROJECT_ID?: string;
  WORKSPACE_RUNTIME_DIR?: string;
};

export type ClaudeMcpCompositionResult = {
  finalPath: string;
  extraArgv: string[];
  cleanupPath?: string;
};

type McpConfig = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
};

export async function composeClaudeMcpConfig(
  workspaceRoot: string,
  strictMode: boolean,
  symphonyTokenEnv: ClaudeMcpTokenEnvironment = {}
): Promise<ClaudeMcpCompositionResult> {
  const workspaceMcpPath = join(workspaceRoot, ".mcp.json");
  const finalPath = strictMode
    ? resolveStrictMcpConfigPath(workspaceRoot, symphonyTokenEnv)
    : workspaceMcpPath;
  const baseConfig = await readBaseMcpConfig(workspaceMcpPath);
  const mergedConfig = mergeGitHubGraphQLMcpServer(baseConfig, symphonyTokenEnv);

  // Non-strict mode intentionally mutates the throwaway workspace .mcp.json so
  // Claude's auto-discovery can pick up both user-authored and Symphony entries.
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(finalPath, JSON.stringify(mergedConfig, null, 2) + "\n", "utf8");

  return {
    finalPath,
    extraArgv: strictMode
      ? ["--strict-mcp-config", "--mcp-config", finalPath]
      : [],
    ...(strictMode ? { cleanupPath: finalPath } : {}),
  };
}

async function readBaseMcpConfig(workspaceMcpPath: string): Promise<McpConfig> {
  try {
    const raw = await readFile(workspaceMcpPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { mcpServers: {} };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { mcpServers: {} };
    }

    throw error;
  }
}

function mergeGitHubGraphQLMcpServer(
  baseConfig: McpConfig,
  env: ClaudeMcpTokenEnvironment
): McpConfig {
  const mcpServers = isRecord(baseConfig.mcpServers)
    ? baseConfig.mcpServers
    : {};

  return {
    ...baseConfig,
    mcpServers: {
      ...mcpServers,
      github_graphql: createGitHubGraphQLMcpServerEntry({
        githubToken: env.GITHUB_GRAPHQL_TOKEN,
        githubGraphqlApiUrl: env.GITHUB_GRAPHQL_API_URL,
        githubTokenBrokerUrl: env.GITHUB_TOKEN_BROKER_URL,
        githubTokenBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET,
        githubTokenCachePath: env.GITHUB_TOKEN_CACHE_PATH,
        githubProjectId: env.GITHUB_PROJECT_ID,
      }),
    },
  };
}

function resolveStrictMcpConfigPath(
  workspaceRoot: string,
  env: ClaudeMcpTokenEnvironment
): string {
  // Direct package tests and ad-hoc callers may not have the worker runtime
  // directory yet; keep their strict config inside the throwaway workspace.
  const runtimeDir =
    env.WORKSPACE_RUNTIME_DIR ?? join(workspaceRoot, ".runtime", basename(workspaceRoot));

  return join(runtimeDir, "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

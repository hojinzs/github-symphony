import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createGitHubGraphQLMcpServerEntry } from "@gh-symphony/tool-github-graphql";
import { createLinearGraphQLMcpServerEntry } from "@gh-symphony/tool-linear-graphql";

export type ClaudeMcpTokenEnvironment = {
  GITHUB_GRAPHQL_TOKEN?: string;
  GITHUB_GRAPHQL_API_URL?: string;
  GITHUB_TOKEN_BROKER_URL?: string;
  GITHUB_TOKEN_BROKER_SECRET?: string;
  GITHUB_TOKEN_CACHE_PATH?: string;
  GITHUB_PROJECT_ID?: string;
  LINEAR_API_KEY?: string;
  LINEAR_AUTHORIZATION?: string;
  LINEAR_GRAPHQL_URL?: string;
  SYMPHONY_TRACKER_KIND?: string;
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
  const finalPath = resolveRuntimeMcpConfigPath(
    workspaceRoot,
    symphonyTokenEnv
  );
  const baseConfig = await readBaseMcpConfig(workspaceMcpPath);
  const mergedConfig = mergeSymphonyMcpServers(baseConfig, symphonyTokenEnv);

  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(
    finalPath,
    JSON.stringify(mergedConfig, null, 2) + "\n",
    "utf8"
  );

  return {
    finalPath,
    extraArgv: strictMode
      ? ["--strict-mcp-config", "--mcp-config", finalPath]
      : ["--mcp-config", finalPath],
    cleanupPath: finalPath,
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

function mergeSymphonyMcpServers(
  baseConfig: McpConfig,
  env: ClaudeMcpTokenEnvironment
): McpConfig {
  const mcpServers = isRecord(baseConfig.mcpServers)
    ? baseConfig.mcpServers
    : {};

  const mergedServers: Record<string, unknown> = {
    ...mcpServers,
    github_graphql: createGitHubGraphQLMcpServerEntry({
      githubToken: env.GITHUB_GRAPHQL_TOKEN,
      githubGraphqlApiUrl: env.GITHUB_GRAPHQL_API_URL,
      githubTokenBrokerUrl: env.GITHUB_TOKEN_BROKER_URL,
      githubTokenBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET,
      githubTokenCachePath: env.GITHUB_TOKEN_CACHE_PATH,
      githubProjectId: env.GITHUB_PROJECT_ID,
    }),
  };

  if (env.SYMPHONY_TRACKER_KIND === "linear") {
    mergedServers.linear_graphql = createLinearGraphQLMcpServerEntry({
      linearGraphqlUrl: env.LINEAR_GRAPHQL_URL,
    });
  } else {
    delete mergedServers.linear_graphql;
  }

  return {
    ...baseConfig,
    mcpServers: mergedServers,
  };
}

function resolveRuntimeMcpConfigPath(
  workspaceRoot: string,
  env: ClaudeMcpTokenEnvironment
): string {
  // Direct package tests and ad-hoc callers may not have the worker runtime
  // directory yet; keep fallback artifacts next to, not inside, the checkout.
  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  const runtimeDir =
    env.WORKSPACE_RUNTIME_DIR ??
    join(
      dirname(normalizedWorkspaceRoot),
      ".runtime",
      basename(normalizedWorkspaceRoot)
    );

  return join(runtimeDir, "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

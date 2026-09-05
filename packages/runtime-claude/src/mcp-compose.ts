import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createGitHubGraphQLMcpServerEntry } from "@gh-symphony/tool-github-graphql";
import { createLinearGraphQLMcpServerEntry } from "@gh-symphony/tool-linear-graphql";
import {
  composeMcpServers,
  type McpServerDefinition,
  readMcpConfig,
} from "@gh-symphony/core";

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
  SYMPHONY_PROJECT_DIR?: string;
  SYMPHONY_TRUST_REPO_CONFIG?: string;
  SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES?: string;
  SYMPHONY_CLAUDE_MCP_URL?: string;
  SYMPHONY_CLAUDE_MCP_SESSION_TOKEN?: string;
};

export type ClaudeMcpCompositionResult = {
  finalPath: string;
  extraArgv: string[];
  cleanupPath?: string;
  excludedServerNames?: string[];
};

export async function composeClaudeMcpConfig(
  workspaceRoot: string,
  _strictMode: boolean,
  symphonyTokenEnv: ClaudeMcpTokenEnvironment = {}
): Promise<ClaudeMcpCompositionResult> {
  const finalPath = resolveRuntimeMcpConfigPath(
    workspaceRoot,
    symphonyTokenEnv
  );
  const trustRepoConfig =
    symphonyTokenEnv.SYMPHONY_TRUST_REPO_CONFIG === "true";
  const builtins = createSymphonyMcpServers(symphonyTokenEnv);
  let mcpServers = composeMcpServers({
    repositoryDir: workspaceRoot,
    projectDir: symphonyTokenEnv.SYMPHONY_PROJECT_DIR,
    trustRepoConfig,
    env: symphonyTokenEnv,
    builtins,
  });
  // The child may connect only to Symphony's worker-owned loopback Streamable
  // HTTP endpoint. Repository/project/user HTTP, SSE, and subprocess
  // declarations are not exposed to the child.
  const builtinNames = new Set(Object.keys(builtins));
  const excludedServerNames = Object.keys(mcpServers)
    .filter((name) => !builtinNames.has(name))
    .sort();
  const symphonyServer = builtins.symphony;
  mcpServers =
    symphonyServer?.type === "http" && typeof symphonyServer.url === "string"
      ? { symphony: symphonyServer }
      : {};
  if (symphonyTokenEnv.SYMPHONY_TRACKER_KIND !== "linear") {
    delete mcpServers.linear_graphql;
  }
  const repositoryConfig = trustRepoConfig
    ? readMcpConfig(join(workspaceRoot, ".mcp.json"))
    : undefined;
  const mergedConfig = { ...repositoryConfig, mcpServers };

  await ensureSecureConfigParent(dirname(finalPath));
  await chmodExistingSecretFile(finalPath);
  await writeFile(finalPath, JSON.stringify(mergedConfig, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(finalPath, 0o600);

  return {
    finalPath,
    extraArgv: ["--strict-mcp-config", "--mcp-config", finalPath],
    cleanupPath: finalPath,
    ...(excludedServerNames.length > 0 ? { excludedServerNames } : {}),
  };
}

async function ensureSecureConfigParent(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (shouldSecureConfigParent(path)) {
    await chmod(path, 0o700);
  }
}

function shouldSecureConfigParent(path: string): boolean {
  if (path === ".") {
    return false;
  }

  const normalizedPath = resolve(path);
  const sharedOrRootPaths = new Set([
    resolve(tmpdir()),
    resolve("/tmp"),
    resolve("/private/tmp"),
    resolve("/"),
  ]);

  return !sharedOrRootPaths.has(normalizedPath);
}

async function chmodExistingSecretFile(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

function createSymphonyMcpServers(
  env: ClaudeMcpTokenEnvironment
): Record<string, McpServerDefinition> {
  if (env.SYMPHONY_CLAUDE_MCP_URL && env.SYMPHONY_CLAUDE_MCP_SESSION_TOKEN) {
    return {
      symphony: {
        type: "http",
        url: env.SYMPHONY_CLAUDE_MCP_URL,
        headers: {
          Authorization: `Bearer ${env.SYMPHONY_CLAUDE_MCP_SESSION_TOKEN}`,
        },
      },
    };
  }

  const mergedServers: Record<string, McpServerDefinition> = {
    github_graphql: createGitHubGraphQLMcpServerEntry({
      githubToken: env.GITHUB_GRAPHQL_TOKEN,
      githubGraphqlApiUrl: env.GITHUB_GRAPHQL_API_URL,
      githubProjectId: env.GITHUB_PROJECT_ID,
    }),
  };

  if (env.SYMPHONY_TRACKER_KIND === "linear") {
    mergedServers.linear_graphql = createLinearGraphQLMcpServerEntry({
      linearGraphqlUrl: env.LINEAR_GRAPHQL_URL,
      linearApiKey: env.LINEAR_API_KEY,
      linearAuthorization: env.LINEAR_AUTHORIZATION,
    });
  } else {
    delete mergedServers.linear_graphql;
  }

  return mergedServers;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

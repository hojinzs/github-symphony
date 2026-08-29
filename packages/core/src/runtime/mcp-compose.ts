import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "../workspace/env-file.js";

export type McpServerDefinition = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
} | {
  type: "sse" | "http";
  url: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};

export type McpCompositionOptions = {
  repositoryDir: string;
  projectDir?: string;
  trustRepoConfig?: boolean;
  builtins?: Record<string, McpServerDefinition>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export class McpConfigError extends Error {}

/** Returns source variable names used for declared secret keys in trusted MCP config. */
export function collectMcpSecretEnvironmentNames(options: {
  repositoryDir: string;
  projectDir?: string;
  trustRepoConfig?: boolean;
  secretEnvironmentNames: readonly string[];
  homeDir?: string;
}): string[] {
  const paths = [
    ...(options.trustRepoConfig
      ? [join(options.repositoryDir, ".mcp.json")]
      : []),
    join(options.homeDir ?? homedir(), ".gh-symphony", "mcp.json"),
    ...(options.projectDir ? [join(options.projectDir, ".mcp.json")] : []),
  ];
  const declaredSecrets = new Set(options.secretEnvironmentNames);
  const sourceNames = new Set<string>();

  for (const path of paths) {
    const config = readMcpConfig(path);
    const servers =
      config && isRecord(config.mcpServers) ? config.mcpServers : {};
    for (const server of Object.values(servers)) {
      if (!isRecord(server) || !isRecord(server.env)) continue;
      for (const [key, value] of Object.entries(server.env)) {
        const match =
          declaredSecrets.has(key) &&
          typeof value === "string" &&
          value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
        if (match) sourceNames.add(match[1]);
      }
    }
  }

  return [...sourceNames].sort();
}

/** Removes declared tracker credentials from already-resolved MCP server envs. */
export function stripMcpServerSecretEnvironmentValues(
  servers: Record<string, McpServerDefinition>,
  secretEnvironmentNames: readonly string[],
  secretEnvironmentValues: readonly string[] = []
): Record<string, McpServerDefinition> {
  const secretNames = new Set(secretEnvironmentNames);
  const secretValues = new Set(secretEnvironmentValues);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.env
        ? {
            ...server,
            env: Object.fromEntries(
              Object.entries(server.env).filter(
                ([key, value]) =>
                  !secretNames.has(key) && !secretValues.has(value)
              )
            ),
          }
        : server,
    ])
  );
}

/** Combines trusted MCP declarations without allowing a sidecar to replace builtins. */
export function composeMcpServers(
  options: McpCompositionOptions
): Record<string, McpServerDefinition> {
  const projectDir = options.projectDir;
  const env = {
    ...process.env,
    ...options.env,
    ...(projectDir ? readEnvFile(join(projectDir, ".env")) : {}),
  };
  const layers = [
    options.trustRepoConfig
      ? readMcpServers(join(options.repositoryDir, ".mcp.json"), env)
      : {},
    readMcpServers(
      join(options.homeDir ?? homedir(), ".gh-symphony", "mcp.json"),
      env
    ),
    projectDir ? readMcpServers(join(projectDir, ".mcp.json"), env) : {},
  ];

  return { ...layers[0], ...layers[1], ...layers[2], ...options.builtins };
}

function readMcpServers(
  path: string,
  env: Record<string, string | undefined>
): Record<string, McpServerDefinition> {
  const config = readMcpConfig(path);
  if (config === undefined) return {};
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  return Object.fromEntries(
    Object.entries(servers).map(([name, value]) => [
      name,
      resolveServer(name, value, env, path),
    ])
  );
}

export function readMcpConfig(
  path: string
): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpConfigError(`Invalid MCP config JSON: ${path}`);
  }
  return isRecord(parsed) ? parsed : {};
}

function resolveServer(
  name: string,
  value: unknown,
  env: Record<string, string | undefined>,
  path: string
): McpServerDefinition {
  if (!isRecord(value)) {
    throw new McpConfigError(`Invalid MCP server "${name}" in ${path}`);
  }
  const server = { ...value } as McpServerDefinition;
  if (
    (server.type === "sse" || server.type === "http") &&
    typeof server.url === "string"
  ) {
    if (server.headers !== undefined && !isRecord(server.headers)) {
      throw new McpConfigError(
        `MCP server "${name}" in ${path} must define headers as an object.`
      );
    }
    return server;
  }
  if (typeof server.command !== "string") {
    throw new McpConfigError(`Invalid MCP server "${name}" in ${path}`);
  }
  if (
    server.args !== undefined &&
    (!Array.isArray(server.args) ||
      !server.args.every((arg) => typeof arg === "string"))
  ) {
    throw new McpConfigError(
      `MCP server "${name}" in ${path} must define args as an array of strings.`
    );
  }
  if (server.env === undefined) return server;
  if (!isRecord(server.env)) {
    throw new McpConfigError(
      `MCP server "${name}" in ${path} must define env as an object.`
    );
  }
  server.env = Object.fromEntries(
    Object.entries(server.env).map(([key, variable]) => {
      if (
        typeof variable !== "string" ||
        !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(variable)
      ) {
        throw new McpConfigError(
          `MCP server "${name}" in ${path} must reference env.${key} as $VAR; literal values are not allowed.`
        );
      }
      const variableName = variable.startsWith("${")
        ? variable.slice(2, -1)
        : variable.slice(1);
      const resolved = env[variableName];
      if (resolved === undefined)
        throw new McpConfigError(
          `MCP server "${name}" in ${path} references unset environment variable ${variable}.`
        );
      return [key, resolved];
    })
  );
  return server;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

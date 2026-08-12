import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "../workspace/env-file.js";

export type McpServerDefinition = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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

/** Combines trusted MCP declarations without allowing a sidecar to replace builtins. */
export function composeMcpServers(
  options: McpCompositionOptions
): Record<string, McpServerDefinition> {
  const projectDir = options.projectDir;
  const env = {
    ...(options.env ?? process.env),
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
  const servers =
    isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  return Object.fromEntries(
    Object.entries(servers).map(([name, value]) => [
      name,
      resolveServer(name, value, env, path),
    ])
  );
}

function resolveServer(
  name: string,
  value: unknown,
  env: Record<string, string | undefined>,
  path: string
): McpServerDefinition {
  if (!isRecord(value) || typeof value.command !== "string") {
    throw new McpConfigError(`Invalid MCP server "${name}" in ${path}`);
  }
  const server = { ...value } as McpServerDefinition;
  if (!isRecord(server.env)) return server;
  server.env = Object.fromEntries(
    Object.entries(server.env).map(([key, variable]) => {
      if (
        typeof variable !== "string" ||
        !/^\$[A-Z_][A-Z0-9_]*$/.test(variable)
      ) {
        throw new McpConfigError(
          `MCP server "${name}" in ${path} must reference env.${key} as $VAR; literal values are not allowed.`
        );
      }
      const resolved = env[variable.slice(1)];
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

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ClaudePreflightStatus = "pass" | "warn" | "fail";

export type ClaudePreflightCheckId =
  | "claude_binary"
  | "anthropic_api_key"
  | "claude_mcp_config"
  | "gh_authentication";

export type ClaudePreflightCheck = {
  id: ClaudePreflightCheckId;
  title: string;
  status: ClaudePreflightStatus;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export type ClaudePreflightReport = {
  ok: boolean;
  checks: ClaudePreflightCheck[];
};

export type ClaudePreflightDependencies = {
  execFileSync: typeof execFileSync;
  readFile: typeof readFile;
  access: typeof access;
  fetchImpl: typeof fetch;
  platform: NodeJS.Platform;
};

export type ClaudePreflightOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Claude CLI binary name or path, for example "claude" or "/usr/local/bin/claude".
   * Full shell command strings are accepted for compatibility and resolved to the binary.
   */
  command?: string;
  includeGhAuth?: boolean;
  probeCredentialBroker?: boolean;
};

const DEFAULT_DEPENDENCIES: ClaudePreflightDependencies = {
  execFileSync,
  readFile,
  access,
  fetchImpl: fetch,
  platform: process.platform,
};

export async function runClaudePreflight(
  options: ClaudePreflightOptions,
  dependencies: Partial<ClaudePreflightDependencies> = {}
): Promise<ClaudePreflightReport> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const env = options.env ?? process.env;
  const command = resolveRuntimeCommandBinary(options.command) ?? "claude";
  const checks: ClaudePreflightCheck[] = [];

  checks.push(checkClaudeBinary(command, deps));
  checks.push(await checkAnthropicApiKey(env, options, deps));
  checks.push(await checkWorkspaceMcpConfig(options.cwd, deps));
  if (options.includeGhAuth) {
    checks.push(checkGhAuthentication(deps));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export function formatClaudePreflightText(
  report: ClaudePreflightReport
): string {
  const lines = ["Claude runtime preflight"];
  for (const check of report.checks) {
    const label =
      check.status === "pass"
        ? "PASS"
        : check.status === "warn"
          ? "WARN"
          : "FAIL";
    lines.push(`${label} ${check.title}`);
    lines.push(`  ${check.summary}`);
    if (check.remediation) {
      lines.push(`  Fix: ${check.remediation}`);
    }
  }
  return lines.join("\n");
}

function pass(
  id: ClaudePreflightCheckId,
  title: string,
  summary: string,
  details?: Record<string, unknown>
): ClaudePreflightCheck {
  return { id, title, status: "pass", summary, details };
}

function warn(
  id: ClaudePreflightCheckId,
  title: string,
  summary: string,
  remediation?: string,
  details?: Record<string, unknown>
): ClaudePreflightCheck {
  return { id, title, status: "warn", summary, remediation, details };
}

function fail(
  id: ClaudePreflightCheckId,
  title: string,
  summary: string,
  remediation: string,
  details?: Record<string, unknown>
): ClaudePreflightCheck {
  return { id, title, status: "fail", summary, remediation, details };
}

function checkClaudeBinary(
  command: string,
  deps: Pick<ClaudePreflightDependencies, "execFileSync" | "platform">
): ClaudePreflightCheck {
  try {
    const locator = deps.platform === "win32" ? "where" : "which";
    const locatedPath = deps
      .execFileSync(locator, [command], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .toString()
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim();
    const version = deps
      .execFileSync(command, ["--version"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .toString()
      .trim();

    return pass(
      "claude_binary",
      "Claude CLI binary",
      version
        ? `${command} is available: ${version}.`
        : `${command} is available, but --version returned an empty response.`,
      { command, path: locatedPath ?? null, version }
    );
  } catch (error) {
    return fail(
      "claude_binary",
      "Claude CLI binary",
      `${command} could not be found or executed from PATH.`,
      `Install Claude Code and ensure '${command}' is on PATH, then re-run the command.`,
      {
        command,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

async function checkAnthropicApiKey(
  env: NodeJS.ProcessEnv,
  options: Pick<ClaudePreflightOptions, "probeCredentialBroker">,
  deps: Pick<ClaudePreflightDependencies, "fetchImpl">
): Promise<ClaudePreflightCheck> {
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return pass(
      "anthropic_api_key",
      "Anthropic API key",
      "ANTHROPIC_API_KEY is configured in the environment.",
      { source: "env" }
    );
  }

  const brokerUrl = env.AGENT_CREDENTIAL_BROKER_URL?.trim();
  const brokerSecret = env.AGENT_CREDENTIAL_BROKER_SECRET?.trim();
  if (!brokerUrl || !brokerSecret) {
    return fail(
      "anthropic_api_key",
      "Anthropic API key",
      "Neither ANTHROPIC_API_KEY nor an agent credential broker is configured.",
      "Set ANTHROPIC_API_KEY or configure AGENT_CREDENTIAL_BROKER_URL and AGENT_CREDENTIAL_BROKER_SECRET.",
      { source: "missing" }
    );
  }

  if (options.probeCredentialBroker === false) {
    return pass(
      "anthropic_api_key",
      "Anthropic API key",
      "Agent credential broker configuration is present.",
      { source: "broker", brokerUrl }
    );
  }

  try {
    const response = await deps.fetchImpl(brokerUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${brokerSecret}`,
      },
    });
    const payload = (await response.json()) as {
      env?: Record<string, string | undefined>;
      error?: string;
    };
    if (response.ok && payload.env?.ANTHROPIC_API_KEY?.trim()) {
      return pass(
        "anthropic_api_key",
        "Anthropic API key",
        "Agent credential broker is reachable and returned ANTHROPIC_API_KEY.",
        { source: "broker", brokerUrl }
      );
    }

    return fail(
      "anthropic_api_key",
      "Anthropic API key",
      payload.error
        ? `Agent credential broker did not return ANTHROPIC_API_KEY: ${payload.error}.`
        : "Agent credential broker did not return ANTHROPIC_API_KEY.",
      "Set ANTHROPIC_API_KEY or configure the credential broker to return ANTHROPIC_API_KEY.",
      { source: "broker", brokerUrl, status: response.status }
    );
  } catch (error) {
    return fail(
      "anthropic_api_key",
      "Anthropic API key",
      "Agent credential broker could not be reached.",
      "Set ANTHROPIC_API_KEY or fix AGENT_CREDENTIAL_BROKER_URL and AGENT_CREDENTIAL_BROKER_SECRET.",
      {
        source: "broker",
        brokerUrl,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

async function checkWorkspaceMcpConfig(
  cwd: string,
  deps: Pick<ClaudePreflightDependencies, "readFile" | "access">
): Promise<ClaudePreflightCheck> {
  const path = join(cwd, ".mcp.json");
  try {
    await deps.access(path, constants.R_OK);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return warn(
        "claude_mcp_config",
        "Workspace .mcp.json",
        ".mcp.json was not found in the workspace root. Claude can still run without a workspace MCP config.",
        undefined,
        { path, reason: "missing" }
      );
    }
    return warn(
      "claude_mcp_config",
      "Workspace .mcp.json",
      `.mcp.json exists but is not readable: ${err.message}.`,
      "Fix .mcp.json file permissions if this workspace needs Claude MCP servers.",
      { path, reason: "unreadable", error: err.message }
    );
  }

  try {
    const content = await deps.readFile(path, "utf8");
    JSON.parse(content);
    return pass(
      "claude_mcp_config",
      "Workspace .mcp.json",
      ".mcp.json is readable and contains valid JSON.",
      { path }
    );
  } catch (error) {
    return fail(
      "claude_mcp_config",
      "Workspace .mcp.json",
      `.mcp.json could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}.`,
      "Fix or remove the workspace root .mcp.json file, then re-run the command.",
      { path, reason: "invalid_json" }
    );
  }
}

function checkGhAuthentication(
  deps: Pick<ClaudePreflightDependencies, "execFileSync">
): ClaudePreflightCheck {
  try {
    deps.execFileSync("gh", ["auth", "status"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return pass(
      "gh_authentication",
      "GitHub CLI authentication",
      "gh auth status succeeded."
    );
  } catch (error) {
    return fail(
      "gh_authentication",
      "GitHub CLI authentication",
      "gh auth status failed or no GitHub login is configured.",
      "Run 'gh auth login --scopes repo,read:org,project' and re-run the command.",
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
}

export function isClaudeRuntimeCommand(
  command: string | null | undefined
): boolean {
  return resolveClaudeCommandBinary(command) != null;
}

export function resolveClaudeCommandBinary(
  command: string | null | undefined
): string | null {
  const binary = resolveRuntimeCommandBinary(command);
  return binary != null && isClaudeBinaryName(binary) ? binary : null;
}

export function resolveRuntimeCommandBinary(
  command: string | null | undefined
): string | null {
  const normalized = (command ?? "").trim();
  if (!normalized) {
    return null;
  }
  const tokens = tokenizeRuntimeCommand(normalized);
  if (tokens.length === 0) {
    return null;
  }
  const first = stripClaudeCommandQuotes(tokens[0]!);
  if (
    (first === "bash" ||
      first === "sh" ||
      first === "zsh" ||
      first === "fish") &&
    tokens.length >= 3
  ) {
    const flagIndex = tokens.findIndex((token) => {
      const value = stripClaudeCommandQuotes(token);
      return value === "-c" || value === "-lc";
    });
    if (flagIndex >= 0 && flagIndex + 1 < tokens.length) {
      return resolveRuntimeCommandBinary(
        stripClaudeCommandQuotes(tokens[flagIndex + 1]!)
      );
    }
  }

  return first;
}

export function stripClaudeCommandQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function tokenizeRuntimeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function isClaudeBinaryName(command: string): boolean {
  const normalized = command.split(/[\\/]/).pop() ?? command;
  return normalized === "claude" || normalized === "claude-code";
}

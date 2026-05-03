export type InitRuntimeKind = "codex-app-server" | "claude-print";

const CODEX_RUNTIME_TOKENS = ["codex-app-server", "codex"] as const;
const CLAUDE_RUNTIME_TOKENS = ["claude-print", "claude-code"] as const;

export const DEFAULT_CODEX_APP_SERVER_ARGS = ["app-server"] as const;

export const DEFAULT_CLAUDE_PRINT_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
] as const;

export function normalizeInitRuntime(runtime: string): InitRuntimeKind | string {
  if (runtime === "codex") {
    return "codex-app-server";
  }
  if (runtime === "claude-code") {
    return "claude-print";
  }
  return runtime;
}

export function isSupportedInitRuntime(runtime: string): boolean {
  const normalized = normalizeInitRuntime(runtime);
  return normalized === "codex-app-server" || normalized === "claude-print";
}

function containsRuntimeToken(
  runtime: string,
  tokens: readonly string[]
): boolean {
  return tokens.some((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s"'\\\`])${escaped}(?=$|[\\s"'\\\`])`).test(
      runtime
    );
  });
}

export function isCodexRuntime(runtime: string): boolean {
  return (
    normalizeInitRuntime(runtime) === "codex-app-server" ||
    containsRuntimeToken(runtime, CODEX_RUNTIME_TOKENS)
  );
}

export function isClaudeRuntime(runtime: string): boolean {
  return (
    normalizeInitRuntime(runtime) === "claude-print" ||
    containsRuntimeToken(runtime, CLAUDE_RUNTIME_TOKENS)
  );
}

export function resolveRuntimeCommand(runtime: string): string {
  const normalized = normalizeInitRuntime(runtime);
  if (normalized === "codex-app-server") {
    return "codex";
  }
  if (normalized === "claude-print") {
    return "claude";
  }
  return runtime;
}

export function resolveRuntimeArgs(runtime: string): readonly string[] {
  const normalized = normalizeInitRuntime(runtime);
  if (normalized === "codex-app-server") {
    return DEFAULT_CODEX_APP_SERVER_ARGS;
  }
  if (normalized === "claude-print") {
    return DEFAULT_CLAUDE_PRINT_ARGS;
  }
  return [];
}

export function resolveRuntimeAgentCommand(runtime: string): string {
  const command = resolveRuntimeCommand(runtime);
  const args = resolveRuntimeArgs(runtime);
  return args.length === 0 ? command : [command, ...args].join(" ");
}

export function resolveShellAgentCommand(runtime: string): string {
  if (/^\s*bash\s+-lc\s+/.test(runtime)) {
    return runtime;
  }
  const normalized = normalizeInitRuntime(runtime);
  if (normalized === "codex-app-server" || normalized === "claude-print") {
    return `bash -lc ${resolveRuntimeAgentCommand(normalized)}`;
  }
  return runtime;
}

export function buildRuntimeFrontMatter(runtime: string): string[] {
  const normalized = normalizeInitRuntime(runtime);

  if (normalized === "codex-app-server") {
    return [
      "runtime:",
      "  kind: codex-app-server",
      "  command: codex",
      "  args:",
      "    - app-server",
      "  isolation:",
      "    bare: false",
      "    strict_mcp_config: false",
      "  timeouts:",
      "    read_timeout_ms: 5000",
      "    turn_timeout_ms: 3600000",
      "    stall_timeout_ms: 300000",
    ];
  }

  if (normalized === "claude-print") {
    return [
      "runtime:",
      "  kind: claude-print",
      "  command: claude",
      "  args:",
      ...DEFAULT_CLAUDE_PRINT_ARGS.map((arg) => `    - ${arg}`),
      "  isolation:",
      "    bare: false",
      "    strict_mcp_config: false",
      "  auth:",
      "    env: ANTHROPIC_API_KEY",
      "  timeouts:",
      "    read_timeout_ms: 5000",
      "    turn_timeout_ms: 3600000",
      "    stall_timeout_ms: 900000",
    ];
  }

  return [
    "runtime:",
    "  kind: custom",
    `  command: ${runtime}`,
    "  isolation:",
    "    bare: false",
    "    strict_mcp_config: false",
    "  timeouts:",
    "    read_timeout_ms: 5000",
    "    turn_timeout_ms: 3600000",
    "    stall_timeout_ms: 300000",
  ];
}

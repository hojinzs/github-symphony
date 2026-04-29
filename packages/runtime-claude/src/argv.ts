export const DEFAULT_CLAUDE_PRINT_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--include-partial-messages",
  // Claude stream-json output requires verbose mode when partial message
  // events are included; keep this even when callers provide custom args.
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
] as const;

export type ClaudeRuntimeSessionOptions =
  | {
      mode: "start";
      sessionId: string;
    }
  | {
      mode: "resume";
      sessionId: string;
      forkSession?: boolean;
    };

export type ClaudeRuntimeIsolationOptions = {
  bare?: boolean;
  strictMcpConfig?: boolean;
  mcpConfigPath?: string;
};

export type ClaudePrintArgvOptions = {
  baseArgs?: readonly string[];
  session?: ClaudeRuntimeSessionOptions;
  isolation?: ClaudeRuntimeIsolationOptions;
  extraArgs?: readonly string[];
};

export function buildClaudePrintArgv(
  options: ClaudePrintArgvOptions = {}
): string[] {
  const args = options.baseArgs
    ? withRequiredClaudePrintArgs(options.baseArgs)
    : ([...DEFAULT_CLAUDE_PRINT_ARGS] as string[]);
  const { session, isolation, extraArgs } = options;

  if (session?.mode === "start") {
    args.push("--session-id", session.sessionId);
  }

  if (session?.mode === "resume") {
    args.push("--resume", session.sessionId);
    if (session.forkSession) {
      args.push("--fork-session");
    }
  }

  if (isolation?.bare) {
    ensureFlag(args, "--bare");
  }

  if (isolation?.strictMcpConfig) {
    ensureFlag(args, "--strict-mcp-config");
    if (isolation.mcpConfigPath) {
      ensureFlagValue(args, "--mcp-config", isolation.mcpConfigPath);
    }
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  return args;
}

function withRequiredClaudePrintArgs(baseArgs: readonly string[]): string[] {
  const args = [...baseArgs];

  ensureFlag(args, "-p");
  ensureFlagValue(args, "--output-format", "stream-json");
  ensureFlagValue(args, "--input-format", "stream-json");
  ensureFlag(args, "--include-partial-messages");
  ensureFlag(args, "--verbose");
  ensureFlagValue(args, "--permission-mode", "bypassPermissions");

  return args;
}

function ensureFlag(args: string[], flag: string): void {
  if (!args.includes(flag)) {
    args.push(flag);
  }
}

function ensureFlagValue(args: string[], flag: string, value: string): void {
  const index = args.indexOf(flag);

  if (index === -1) {
    args.push(flag, value);
    return;
  }

  const existingValue = args[index + 1];
  if (existingValue?.startsWith("-")) {
    args.splice(index + 1, 0, value);
    return;
  }

  if (existingValue !== value) {
    args.splice(index + 1, existingValue === undefined ? 0 : 1, value);
  }
}

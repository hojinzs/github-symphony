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
  const args = [...(options.baseArgs ?? DEFAULT_CLAUDE_PRINT_ARGS)] as string[];
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
    args.push("--bare");
  }

  if (isolation?.strictMcpConfig) {
    args.push("--strict-mcp-config");
    if (isolation.mcpConfigPath) {
      args.push("--mcp-config", isolation.mcpConfigPath);
    }
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  return args;
}

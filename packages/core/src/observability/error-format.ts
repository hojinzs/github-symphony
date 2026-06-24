export type TerminalErrorFormatOptions = {
  verbose?: boolean;
};

export function hasVerboseFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--verbose" || arg === "-v");
}

export function formatErrorForTerminal(
  error: unknown,
  options: TerminalErrorFormatOptions = {}
): string {
  if (!options.verbose) {
    return `${error instanceof Error ? error.message : "Unknown error"}\n`;
  }

  const lines = [formatSingleError(error)];
  const seenCauses = new Set<object>();
  if (typeof error === "object" && error !== null) {
    seenCauses.add(error);
  }
  let cause = resolveCause(error);

  while (cause !== undefined) {
    if (typeof cause === "object" && cause !== null) {
      if (seenCauses.has(cause)) {
        lines.push("Caused by: [Circular cause]");
        break;
      }
      seenCauses.add(cause);
    }

    lines.push(`Caused by: ${formatSingleError(cause)}`);
    cause = resolveCause(cause);
  }

  return `${lines.join("\n")}\n`;
}

function formatSingleError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function resolveCause(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

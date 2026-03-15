import { parseArgs, type ParseArgsConfig, type ParseArgsOptionsConfig } from "node:util";

type ParseCliArgsResult = ReturnType<typeof parseArgs> | { error: string };

export function parseCliArgs(
  args: string[],
  options: ParseArgsOptionsConfig
): ParseCliArgsResult {
  try {
    return parseArgs({
      args,
      options,
      allowPositionals: false,
      strict: true,
    } satisfies ParseArgsConfig);
  } catch (error) {
    return { error: formatParseArgsError(error) };
  }
}

function formatParseArgsError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Invalid arguments";
}

export type CliErrorCode =
  | "invalid_arguments"
  | "missing_workflow_file"
  | "repository_initialization_failed"
  | "missing_repository_runtime_config"
  | "status_snapshot_unavailable"
  | "repository_not_configured"
  | "repository_mismatch"
  | "github_auth_required"
  | "workflow_load_failed"
  | "unknown_command";

export function writeCliError(input: {
  code: CliErrorCode;
  message: string;
  json?: boolean;
  exitCode?: number;
  usage?: string;
}): void {
  const exitCode = input.exitCode ?? 1;
  if (input.json) {
    process.stdout.write(
      JSON.stringify(
        {
          error: {
            code: input.code,
            message: input.message,
          },
        },
        null,
        2
      ) + "\n"
    );
  } else {
    process.stderr.write(`${input.message}\n`);
    if (input.usage) {
      process.stderr.write(`${input.usage}\n`);
    }
  }
  process.exitCode = exitCode;
}

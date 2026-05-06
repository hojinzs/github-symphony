export const REMOVED_PROJECT_ID_MESSAGE =
  "--project-id has been removed. gh-symphony now uses the current repository directory; run the command from the target repo or pass --repo-dir where supported.";

export function rejectRemovedProjectId(
  args: readonly string[],
  options: { rejectProjectAlias?: boolean } = { rejectProjectAlias: true }
): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (
      arg === "--project-id" ||
      (options.rejectProjectAlias !== false && arg === "--project")
    ) {
      process.stderr.write(`${REMOVED_PROJECT_ID_MESSAGE}\n`);
      process.exitCode = 2;
      return true;
    }
    if (
      arg?.startsWith("--project-id=") ||
      (options.rejectProjectAlias !== false && arg?.startsWith("--project="))
    ) {
      process.stderr.write(`${REMOVED_PROJECT_ID_MESSAGE}\n`);
      process.exitCode = 2;
      return true;
    }
  }

  return false;
}

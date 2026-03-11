import type { GlobalOptions } from "../index.js";
import { runCli as orchestratorRunCli } from "@gh-symphony/orchestrator";
import {
  resolveRuntimeRoot,
  resolveWorkspaceConfig,
  syncWorkspaceToRuntime,
} from "../orchestrator-runtime.js";

function parseRunArgs(args: string[]): {
  issue?: string;
  watch: boolean;
  workspaceId?: string;
} {
  const parsed: { issue?: string; watch: boolean; workspaceId?: string } = {
    watch: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
    } else if (arg === "--workspace" || arg === "--workspace-id") {
      parsed.workspaceId = args[i + 1];
      i += 1;
    } else if (!arg?.startsWith("--")) {
      // Positional arg = issue identifier
      parsed.issue = arg;
    }
  }
  return parsed;
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseRunArgs(args);

  if (!parsed.issue) {
    process.stderr.write("Usage: gh-symphony run <owner/repo#number>\n");
    process.exitCode = 2;
    return;
  }

  const wsConfig = await resolveWorkspaceConfig(
    options.configDir,
    parsed.workspaceId
  );
  if (!wsConfig) {
    process.stderr.write(
      "No workspace configured. Run 'gh-symphony init' first.\n"
    );
    process.exitCode = 1;
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const workspaceId = wsConfig.workspaceId;
  await syncWorkspaceToRuntime(options.configDir, wsConfig);

  // Validate the issue identifier belongs to a configured repo
  const [repoSpec] = parsed.issue.split("#");
  if (
    repoSpec &&
    !wsConfig.repositories.some((r) => `${r.owner}/${r.name}` === repoSpec)
  ) {
    process.stderr.write(
      `Repository "${repoSpec}" is not configured in this workspace.\n` +
        `Configured repos: ${wsConfig.repositories.map((r) => `${r.owner}/${r.name}`).join(", ")}\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Dispatching issue: ${parsed.issue}\n`);

  await orchestratorRunCli([
    "run-issue",
    "--runtime-root",
    runtimeRoot,
    "--workspace-id",
    workspaceId,
    "--issue",
    parsed.issue,
  ]);

  if (parsed.watch) {
    process.stdout.write("\nWatching for status changes...\n");
    await orchestratorRunCli([
      "status",
      "--runtime-root",
      runtimeRoot,
      "--workspace-id",
      workspaceId,
    ]);
  }
};

export default handler;

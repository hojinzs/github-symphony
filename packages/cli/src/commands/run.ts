import type { GlobalOptions } from "../index.js";
import { runCli as orchestratorRunCli } from "@gh-symphony/orchestrator";
import {
  resolveRuntimeRoot,
  syncProjectToRuntime,
} from "../orchestrator-runtime.js";
import { resolveManagedProjectConfig } from "../project-selection.js";

function parseRunArgs(args: string[]): {
  issue?: string;
  watch: boolean;
  projectId?: string;
} {
  const parsed: { issue?: string; watch: boolean; projectId?: string } = {
    watch: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
    } else if (arg === "--project" || arg === "--project-id") {
      parsed.projectId = args[i + 1];
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

  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: parsed.projectId,
  });
  if (!projectConfig) {
    if (process.exitCode !== 1) {
      process.stderr.write(
        "No project configured. Run 'gh-symphony project add' first.\n"
      );
      process.exitCode = 1;
    }
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const projectId = projectConfig.projectId;
  await syncProjectToRuntime(options.configDir, projectConfig);

  // Validate the issue identifier belongs to a configured repo
  const [repoSpec] = parsed.issue.split("#");
  if (
    repoSpec &&
    !projectConfig.repositories.some((r) => `${r.owner}/${r.name}` === repoSpec)
  ) {
    process.stderr.write(
      `Repository "${repoSpec}" is not configured in this project.\n` +
        `Configured repos: ${projectConfig.repositories.map((r) => `${r.owner}/${r.name}`).join(", ")}\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Dispatching issue: ${parsed.issue}\n`);

  await orchestratorRunCli([
    "run-issue",
    "--runtime-root",
    runtimeRoot,
    "--project-id",
    projectId,
    "--issue",
    parsed.issue,
  ]);

  if (parsed.watch) {
    process.stdout.write("\nWatching for status changes...\n");
    await orchestratorRunCli([
      "status",
      "--runtime-root",
      runtimeRoot,
      "--project-id",
      projectId,
    ]);
  }
};

export default handler;

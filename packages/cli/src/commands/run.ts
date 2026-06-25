import type { GlobalOptions } from "../index.js";
import { runCli as orchestratorRunCli } from "@gh-symphony/orchestrator";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";
import { writeCliError } from "../cli-error.js";

function parseRunArgs(args: string[]): {
  issue?: string;
  watch: boolean;
  projectId?: string;
  logLevel?: string;
  error?: string;
} {
  const parsed: {
    issue?: string;
    watch: boolean;
    projectId?: string;
    logLevel?: string;
    error?: string;
  } = {
    watch: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
    } else if (arg === "--project" || arg === "--project-id") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.projectId = value;
      i += 1;
    } else if (arg === "--log-level") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.logLevel = value;
      i += 1;
    } else if (!arg?.startsWith("-")) {
      // Positional arg = issue identifier
      parsed.issue = arg;
    } else {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }
  }
  return parsed;
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseRunArgs(args);

  if (parsed.error) {
    writeCliError({
      code: "invalid_arguments",
      message: parsed.error,
      json: options.json,
      exitCode: 2,
    });
    return;
  }

  if (!parsed.issue) {
    writeCliError({
      code: "invalid_arguments",
      message: "Issue identifier argument missing",
      usage: "Usage: gh-symphony repo run <owner/repo#number>",
      json: options.json,
      exitCode: 2,
    });
    return;
  }

  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: parsed.projectId,
    json: options.json,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig({ json: options.json });
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const projectId = projectConfig.projectId;
  // Validate the issue identifier belongs to a configured repo
  const [repoSpec] = parsed.issue.split("#");
  const configuredRepos = [projectConfig.repository]
    .filter((repository): repository is NonNullable<typeof repository> =>
      Boolean(repository?.owner && repository.name)
    )
    .map((repository) => `${repository.owner}/${repository.name}`);
  const configuredRepoSet = new Set(configuredRepos);
  if (configuredRepoSet.size === 0) {
    writeCliError({
      code: "repository_not_configured",
      message:
        "No repository is configured in this project. Run 'gh-symphony repo init' from the target repository first.",
      json: options.json,
    });
    return;
  }

  if (repoSpec && !configuredRepoSet.has(repoSpec)) {
    writeCliError({
      code: "repository_mismatch",
      message: `Repository "${repoSpec}" is not configured in this project. Configured repo: ${configuredRepos.join(", ")}`,
      json: options.json,
    });
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
    ...(parsed.logLevel ? ["--log-level", parsed.logLevel] : []),
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

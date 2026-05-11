import type { GlobalOptions } from "../index.js";
import logsCommand from "./logs.js";
import recoverCommand from "./recover.js";
import repoExplainCommand from "./repo-explain.js";
import runCommand from "./run.js";
import startCommand from "./start.js";
import statusCommand from "./status.js";
import stopCommand from "./stop.js";
import {
  initRepoRuntime,
  parseRepoRuntimeFlags,
} from "../repo-runtime.js";
import { resolveRepoRuntimeRoot } from "../orchestrator-runtime.js";
import { rejectRemovedProjectId } from "../removed-project-id.js";

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "init":
      await repoInit(rest, options);
      break;
    case "start":
      if (rejectRemovedProjectId(rest)) return;
      await startCommand(rest, repoOptions(options));
      break;
    case "run":
      if (rejectRemovedProjectId(rest)) return;
      await runCommand(rest, repoOptions(options));
      break;
    case "recover":
      if (rejectRemovedProjectId(rest)) return;
      await recoverCommand(rest, repoOptions(options));
      break;
    case "logs":
      if (rejectRemovedProjectId(rest)) return;
      await logsCommand(rest, repoOptions(options));
      break;
    case "explain":
      if (rejectRemovedProjectId(rest)) return;
      await repoExplainCommand(rest, repoOptions(options));
      break;
    case "status":
      if (rejectRemovedProjectId(rest)) return;
      await statusCommand(rest, repoOptions(options));
      break;
    case "stop":
      if (rejectRemovedProjectId(rest)) return;
      await stopCommand(rest, repoOptions(options));
      break;
    default:
      process.stderr.write(
        "Usage: gh-symphony repo <init|start|status|stop|run|recover|logs|explain|list|add|remove|sync> [repo]\n"
      );
      process.exitCode = 2;
  }
};

export default handler;

function repoOptions(options: GlobalOptions): GlobalOptions {
  return {
    ...options,
    configDir: resolveRepoRuntimeRoot(),
  };
}

async function repoInit(args: string[], options: GlobalOptions): Promise<void> {
  if (rejectRemovedProjectId(args)) {
    return;
  }

  let flags: ReturnType<typeof parseRepoRuntimeFlags>;
  try {
    flags = parseRepoRuntimeFlags(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid arguments"}\n`
    );
    process.stderr.write(
      "Usage: gh-symphony repo init [--repo-dir <path>] [--workflow-file <path>]\n"
    );
    process.exitCode = 2;
    return;
  }

  try {
    const result = await initRepoRuntime(flags);
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      [
        `Repository initialized: ${formatRepoSpec(result.repository)}`,
        `Runtime: ${result.configDir}`,
        `Workflow: ${result.workflowPath}`,
      ].join("\n") + "\n"
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Repository initialization failed."}\n`
    );
    process.exitCode = 1;
  }
}

function formatRepoSpec(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

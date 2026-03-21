import { runCli as dashboardRunCli } from "@gh-symphony/dashboard";
import type { GlobalOptions } from "../index.js";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";

function parseDashboardArgs(args: string[]): {
  port?: string;
  projectId?: string;
  error?: string;
} {
  const parsed: {
    port?: string;
    projectId?: string;
    error?: string;
  } = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "--project-id") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.projectId = value;
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = "Option '--port' argument missing";
        return parsed;
      }
      parsed.port = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
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
  const parsed = parseDashboardArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony dashboard [--project-id <project-id>] [--port <number>]\n"
    );
    process.exitCode = 2;
    return;
  }

  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: parsed.projectId,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig();
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  await dashboardRunCli([
    "--runtime-root",
    runtimeRoot,
    "--project-id",
    projectConfig.projectId,
    ...(parsed.port ? ["--port", parsed.port] : []),
  ]);
};

export default handler;

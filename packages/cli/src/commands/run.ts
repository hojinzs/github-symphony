import type { GlobalOptions } from "../index.js";
import { runCli as orchestratorRunCli } from "@gh-symphony/orchestrator";
import {
  resolveRuntimeRoot,
  resolveTenantConfig,
  syncTenantToRuntime,
} from "../orchestrator-runtime.js";

function parseRunArgs(args: string[]): {
  issue?: string;
  watch: boolean;
  tenantId?: string;
} {
  const parsed: { issue?: string; watch: boolean; tenantId?: string } = {
    watch: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      parsed.watch = true;
    } else if (arg === "--tenant" || arg === "--tenant-id") {
      parsed.tenantId = args[i + 1];
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

  const tenantConfig = await resolveTenantConfig(
    options.configDir,
    parsed.tenantId
  );
  if (!tenantConfig) {
    process.stderr.write(
      "No tenant configured. Run 'gh-symphony init' first.\n"
    );
    process.exitCode = 1;
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const tenantId = tenantConfig.tenantId;
  await syncTenantToRuntime(options.configDir, tenantConfig);

  // Validate the issue identifier belongs to a configured repo
  const [repoSpec] = parsed.issue.split("#");
  if (
    repoSpec &&
    !tenantConfig.repositories.some((r) => `${r.owner}/${r.name}` === repoSpec)
  ) {
    process.stderr.write(
      `Repository "${repoSpec}" is not configured in this tenant.\n` +
        `Configured repos: ${tenantConfig.repositories.map((r) => `${r.owner}/${r.name}`).join(", ")}\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Dispatching issue: ${parsed.issue}\n`);

  await orchestratorRunCli([
    "run-issue",
    "--runtime-root",
    runtimeRoot,
    "--tenant-id",
    tenantId,
    "--issue",
    parsed.issue,
  ]);

  if (parsed.watch) {
    process.stdout.write("\nWatching for status changes...\n");
    await orchestratorRunCli([
      "status",
      "--runtime-root",
      runtimeRoot,
      "--tenant-id",
      tenantId,
    ]);
  }
};

export default handler;

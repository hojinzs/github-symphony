import type { GlobalOptions } from "../index.js";
import {
  loadActiveTenantConfig,
  loadGlobalConfig,
  saveTenantConfig,
} from "../config.js";

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "list":
      await repoList(options);
      break;
    case "add":
      await repoAdd(rest, options);
      break;
    case "remove":
      await repoRemove(rest, options);
      break;
    default:
      process.stderr.write(
        "Usage: gh-symphony repo <list|add|remove> [repo]\n"
      );
      process.exitCode = 2;
  }
};

export default handler;

// ── 6.4: repo list / add / remove ────────────────────────────────────────────

async function repoList(options: GlobalOptions): Promise<void> {
  const ws = await loadActiveTenantConfig(options.configDir);
  if (!ws) {
    process.stderr.write("No tenant configured.\n");
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(ws.repositories, null, 2) + "\n");
    return;
  }

  process.stdout.write("Repositories:\n");
  for (const repo of ws.repositories) {
    process.stdout.write(`  ${repo.owner}/${repo.name}\n`);
  }
}

async function repoAdd(args: string[], options: GlobalOptions): Promise<void> {
  const [repoSpec] = args;
  if (!repoSpec || !repoSpec.includes("/")) {
    process.stderr.write("Usage: gh-symphony repo add <owner/name>\n");
    process.exitCode = 2;
    return;
  }

  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeTenant) {
    process.stderr.write("No active tenant.\n");
    process.exitCode = 1;
    return;
  }

  const ws = await loadActiveTenantConfig(options.configDir);
  if (!ws) {
    process.stderr.write("Tenant config missing.\n");
    process.exitCode = 1;
    return;
  }

  const [owner, name] = repoSpec.split("/");
  if (!owner || !name) {
    process.stderr.write("Invalid repo format. Use: owner/name\n");
    process.exitCode = 2;
    return;
  }

  if (ws.repositories.some((r) => r.owner === owner && r.name === name)) {
    process.stdout.write(`Repository ${repoSpec} is already configured.\n`);
    return;
  }

  ws.repositories.push({
    owner,
    name,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
  });

  await saveTenantConfig(options.configDir, global.activeTenant, ws);
  process.stdout.write(`Added repository: ${repoSpec}\n`);
}

async function repoRemove(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const [repoSpec] = args;
  if (!repoSpec || !repoSpec.includes("/")) {
    process.stderr.write("Usage: gh-symphony repo remove <owner/name>\n");
    process.exitCode = 2;
    return;
  }

  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeTenant) {
    process.stderr.write("No active tenant.\n");
    process.exitCode = 1;
    return;
  }

  const ws = await loadActiveTenantConfig(options.configDir);
  if (!ws) {
    process.stderr.write("Tenant config missing.\n");
    process.exitCode = 1;
    return;
  }

  const [owner, name] = repoSpec.split("/");
  const idx = ws.repositories.findIndex(
    (r) => r.owner === owner && r.name === name
  );

  if (idx === -1) {
    process.stderr.write(`Repository ${repoSpec} is not configured.\n`);
    process.exitCode = 1;
    return;
  }

  ws.repositories.splice(idx, 1);
  await saveTenantConfig(options.configDir, global.activeTenant, ws);
  process.stdout.write(`Removed repository: ${repoSpec}\n`);
}

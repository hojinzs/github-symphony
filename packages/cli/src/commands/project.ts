import * as p from "@clack/prompts";
import type { GlobalOptions } from "../index.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadTenantConfig,
} from "../config.js";

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand] = args;

  switch (subcommand) {
    case "list":
      await projectList(options);
      break;
    case "switch":
      await projectSwitch(options);
      break;
    case "status":
      await projectStatus(options);
      break;
    default:
      process.stderr.write("Usage: gh-symphony project <list|switch|status>\n");
      process.exitCode = 2;
  }
};

export default handler;

// ── 6.1: project list ────────────────────────────────────────────────────────

async function projectList(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global || global.tenants.length === 0) {
    process.stdout.write("No tenants configured. Run 'gh-symphony init'.\n");
    return;
  }

  if (options.json) {
    const configs: Array<{ id: string; active: boolean; repos: number }> = [];
    for (const tId of global.tenants) {
      const t = await loadTenantConfig(options.configDir, tId);
      configs.push({
        id: tId,
        active: tId === global.activeTenant,
        repos: t?.repositories.length ?? 0,
      });
    }
    process.stdout.write(JSON.stringify(configs, null, 2) + "\n");
    return;
  }

  process.stdout.write("Tenants:\n\n");
  for (const tId of global.tenants) {
    const t = await loadTenantConfig(options.configDir, tId);
    const active = tId === global.activeTenant ? " (active)" : "";
    const repos = t?.repositories.length ?? 0;
    process.stdout.write(
      `  ${tId}${active} — ${repos} repo${repos === 1 ? "" : "s"}\n`
    );
  }
}

// ── 6.2: project switch ──────────────────────────────────────────────────────

async function projectSwitch(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global || global.tenants.length === 0) {
    process.stderr.write("No tenants configured. Run 'gh-symphony init'.\n");
    process.exitCode = 1;
    return;
  }

  if (global.tenants.length === 1) {
    process.stdout.write(
      `Only one tenant exists: ${global.tenants[0]}\n`
    );
    return;
  }

  const selected = await p.select({
    message: "Select tenant to activate:",
    options: global.tenants.map((tId) => ({
      value: tId,
      label: tId,
      hint: tId === global.activeTenant ? "current" : undefined,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    return;
  }

  global.activeTenant = selected;
  await saveGlobalConfig(options.configDir, global);
  process.stdout.write(`Switched to tenant: ${selected}\n`);
}

// ── 6.3: project status ──────────────────────────────────────────────────────

async function projectStatus(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeTenant) {
    process.stderr.write("No active tenant.\n");
    process.exitCode = 1;
    return;
  }

  const t = await loadTenantConfig(
    options.configDir,
    global.activeTenant
  );
  if (!t) {
    process.stderr.write(
      `Tenant config missing: ${global.activeTenant}\n`
    );
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Tenant:      ${t.tenantId}\n`);
  process.stdout.write(
    `Tracker:     ${t.tracker.adapter} (${t.tracker.bindingId})\n`
  );
  process.stdout.write(`Repositories:\n`);
  for (const repo of t.repositories) {
    process.stdout.write(`  - ${repo.owner}/${repo.name}\n`);
  }
}

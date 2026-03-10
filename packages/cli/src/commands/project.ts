import * as p from "@clack/prompts";
import type { GlobalOptions } from "../index.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadWorkspaceConfig,
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
  if (!global || global.workspaces.length === 0) {
    process.stdout.write("No workspaces configured. Run 'gh-symphony init'.\n");
    return;
  }

  if (options.json) {
    const configs: Array<{ id: string; active: boolean; repos: number }> = [];
    for (const wsId of global.workspaces) {
      const ws = await loadWorkspaceConfig(options.configDir, wsId);
      configs.push({
        id: wsId,
        active: wsId === global.activeWorkspace,
        repos: ws?.repositories.length ?? 0,
      });
    }
    process.stdout.write(JSON.stringify(configs, null, 2) + "\n");
    return;
  }

  process.stdout.write("Workspaces:\n\n");
  for (const wsId of global.workspaces) {
    const ws = await loadWorkspaceConfig(options.configDir, wsId);
    const active = wsId === global.activeWorkspace ? " (active)" : "";
    const repos = ws?.repositories.length ?? 0;
    process.stdout.write(
      `  ${wsId}${active} — ${repos} repo${repos === 1 ? "" : "s"}\n`
    );
  }
}

// ── 6.2: project switch ──────────────────────────────────────────────────────

async function projectSwitch(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global || global.workspaces.length === 0) {
    process.stderr.write("No workspaces configured. Run 'gh-symphony init'.\n");
    process.exitCode = 1;
    return;
  }

  if (global.workspaces.length === 1) {
    process.stdout.write(
      `Only one workspace exists: ${global.workspaces[0]}\n`
    );
    return;
  }

  const selected = await p.select({
    message: "Select workspace to activate:",
    options: global.workspaces.map((wsId) => ({
      value: wsId,
      label: wsId,
      hint: wsId === global.activeWorkspace ? "current" : undefined,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    return;
  }

  global.activeWorkspace = selected;
  await saveGlobalConfig(options.configDir, global);
  process.stdout.write(`Switched to workspace: ${selected}\n`);
}

// ── 6.3: project status ──────────────────────────────────────────────────────

async function projectStatus(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeWorkspace) {
    process.stderr.write("No active workspace.\n");
    process.exitCode = 1;
    return;
  }

  const ws = await loadWorkspaceConfig(
    options.configDir,
    global.activeWorkspace
  );
  if (!ws) {
    process.stderr.write(
      `Workspace config missing: ${global.activeWorkspace}\n`
    );
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(ws, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Workspace:   ${ws.workspaceId}\n`);
  process.stdout.write(
    `Tracker:     ${ws.tracker.adapter} (${ws.tracker.bindingId})\n`
  );
  process.stdout.write(`Repositories:\n`);
  for (const repo of ws.repositories) {
    process.stdout.write(`  - ${repo.owner}/${repo.name}\n`);
  }
}

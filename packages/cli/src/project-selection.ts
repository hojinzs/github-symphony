import * as p from "@clack/prompts";
import {
  loadGlobalConfig,
  loadProjectConfig,
  type CliProjectConfig,
} from "./config.js";

type ResolveProjectSelectionInput = {
  configDir: string;
  requestedProjectId?: string;
};

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function explicitProjectRequiredMessage(): string {
  return "Multiple projects are configured. Re-run with --project-id in non-interactive environments.\n";
}

export async function resolveManagedProjectConfig(
  input: ResolveProjectSelectionInput
): Promise<CliProjectConfig | null> {
  if (input.requestedProjectId) {
    return loadProjectConfig(input.configDir, input.requestedProjectId);
  }

  const global = await loadGlobalConfig(input.configDir);
  const projectIds = global?.projects ?? [];

  if (projectIds.length === 0) {
    return null;
  }

  if (projectIds.length === 1) {
    return loadProjectConfig(input.configDir, projectIds[0]!);
  }

  if (!isInteractiveTerminal()) {
    process.stderr.write(explicitProjectRequiredMessage());
    process.exitCode = 1;
    return null;
  }

  const projects = await Promise.all(
    projectIds.map(async (projectId) => ({
      projectId,
      config: await loadProjectConfig(input.configDir, projectId),
    }))
  );

  const selected = await p.select({
    message: "Select a project:",
    options: projects.map(({ projectId, config }) => ({
      value: projectId,
      label: config?.displayName ?? config?.slug ?? projectId,
      hint:
        projectId === global?.activeProject
          ? "current"
          : config && config.displayName && config.displayName !== projectId
            ? projectId
            : undefined,
    })),
    maxItems: 10,
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exitCode = 130;
    return null;
  }

  return loadProjectConfig(input.configDir, selected);
}

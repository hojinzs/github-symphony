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

export type ManagedProjectResolution =
  | {
      kind: "resolved";
      projectId: string;
      projectConfig: CliProjectConfig;
    }
  | {
      kind:
        | "missing_global_config"
        | "no_projects"
        | "requested_project_missing"
        | "active_project_missing"
        | "configured_project_missing"
        | "multiple_projects_require_selection";
      message: string;
      projectId?: string;
    };

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function explicitProjectRequiredMessage(): string {
  return "Multiple projects are configured. Re-run with --project-id in non-interactive environments.\n";
}

export async function inspectManagedProjectSelection(
  input: ResolveProjectSelectionInput
): Promise<ManagedProjectResolution> {
  if (input.requestedProjectId) {
    const projectConfig = await loadProjectConfig(
      input.configDir,
      input.requestedProjectId
    );
    if (!projectConfig) {
      return {
        kind: "requested_project_missing",
        projectId: input.requestedProjectId,
        message: `Project "${input.requestedProjectId}" is not configured. Run 'gh-symphony project add' or choose an existing project.`,
      };
    }

    return {
      kind: "resolved",
      projectId: input.requestedProjectId,
      projectConfig,
    };
  }

  const global = await loadGlobalConfig(input.configDir);
  if (!global) {
    return {
      kind: "missing_global_config",
      message: "No CLI configuration found. Run 'gh-symphony project add' first.",
    };
  }

  const projectIds = global.projects ?? [];
  if (projectIds.length === 0) {
    return {
      kind: "no_projects",
      message: "No managed projects are configured. Run 'gh-symphony project add' first.",
    };
  }

  if (projectIds.length > 1 && !isInteractiveTerminal()) {
    return {
      kind: "multiple_projects_require_selection",
      message: explicitProjectRequiredMessage().trimEnd(),
    };
  }

  if (global.activeProject) {
    const projectConfig = await loadProjectConfig(
      input.configDir,
      global.activeProject
    );
    if (!projectConfig) {
      return {
        kind: "active_project_missing",
        projectId: global.activeProject,
        message: `Active project "${global.activeProject}" is configured in config.json but its project config is missing. Re-run 'gh-symphony project add' or 'gh-symphony project switch'.`,
      };
    }

    return {
      kind: "resolved",
      projectId: global.activeProject,
      projectConfig,
    };
  }

  if (projectIds.length === 1) {
    const projectId = projectIds[0]!;
    const projectConfig = await loadProjectConfig(input.configDir, projectId);
    if (!projectConfig) {
      return {
        kind: "configured_project_missing",
        projectId,
        message: `Configured project "${projectId}" is missing its project config file. Re-run 'gh-symphony project add'.`,
      };
    }

    return {
      kind: "resolved",
      projectId,
      projectConfig,
    };
  }

  return {
    kind: "multiple_projects_require_selection",
    message:
      "Multiple projects are configured and no active project is set. Run 'gh-symphony project switch' or re-run with --project-id.",
  };
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

export function handleMissingManagedProjectConfig(): void {
  if (process.exitCode) {
    return;
  }

  process.stderr.write(
    "No project configured. Run 'gh-symphony project add' first.\n"
  );
  process.exitCode = 1;
}

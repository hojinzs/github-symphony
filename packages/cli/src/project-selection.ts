import * as p from "@clack/prompts";
import { isAbsolute, relative, resolve } from "node:path";
import {
  loadGlobalConfig,
  loadProjectConfig,
  type CliProjectConfig,
} from "./config.js";
import { writeCliError } from "./cli-error.js";
import { standaloneProjectId } from "./standalone-project.js";

type ResolveProjectSelectionInput = {
  configDir: string;
  requestedProjectId?: string;
  cwd?: string;
  json?: boolean;
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
  return "Multiple repository runtime configs are present. Run 'gh-symphony repo init' from the target repository to refresh the cwd runtime.\n";
}

function diagnosticProjectRequiredMessage(): string {
  return "Multiple managed projects are configured, cwd has no cached standalone runtime config, and no active project is set. Run 'gh-symphony project start' from the standalone project folder to refresh its runtime config, run the diagnostic from that folder, or pass '--project-id <project-id>' to select one. Run 'gh-symphony project list' to see configured project ids. For doctor, you can also pass '--project-dir <path>'.";
}

function projectConfigRemediation(): string {
  return "For a standalone project, run 'gh-symphony project start' from its project folder to refresh the runtime config, then run diagnostics from that folder or select it explicitly. For a repository runtime, run 'gh-symphony repo init' from the target repository.";
}

function missingProjectConfigMessage(projectId: string): string {
  return `Project "${projectId}" is not configured. ${projectConfigRemediation()}`;
}

async function loadStandaloneProjectFromCwd(
  configDir: string,
  cwd: string
): Promise<{ projectId: string; projectConfig: CliProjectConfig } | null> {
  const resolvedCwd = resolve(cwd);
  const projectId = standaloneProjectId(resolvedCwd);
  const projectConfig = await loadProjectConfig(configDir, projectId);
  if (
    projectConfig?.projectDir &&
    resolve(projectConfig.projectDir) === resolvedCwd
  ) {
    return { projectId, projectConfig };
  }
  return null;
}

async function loadRepositoryProjectFromCwd(
  configDir: string,
  cwd: string,
  projectIds: readonly string[]
): Promise<{ projectId: string; projectConfig: CliProjectConfig } | null> {
  const resolvedCwd = resolve(cwd);
  let bestMatch: { projectId: string; projectConfig: CliProjectConfig } | null =
    null;
  for (const projectId of projectIds) {
    const projectConfig = await loadProjectConfig(configDir, projectId);
    const repositoryDir = projectConfig?.repositoryDir
      ? resolve(projectConfig.repositoryDir)
      : undefined;
    if (!repositoryDir) {
      continue;
    }
    const pathToCwd = relative(repositoryDir, resolvedCwd);
    const containsCwd =
      pathToCwd === "" ||
      (!pathToCwd.startsWith("..") && !isAbsolute(pathToCwd));
    if (
      containsCwd &&
      (!bestMatch ||
        repositoryDir.length > resolve(bestMatch.projectConfig.repositoryDir!).length)
    ) {
      bestMatch = { projectId, projectConfig };
    }
  }
  return bestMatch;
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
        message: missingProjectConfigMessage(input.requestedProjectId),
      };
    }

    return {
      kind: "resolved",
      projectId: input.requestedProjectId,
      projectConfig,
    };
  }

  const cwdProject = await loadStandaloneProjectFromCwd(
    input.configDir,
    input.cwd ?? process.cwd()
  );
  if (cwdProject) {
    return { kind: "resolved", ...cwdProject };
  }

  const global = await loadGlobalConfig(input.configDir);
  if (!global) {
    return {
      kind: "missing_global_config",
      message:
        "No repository runtime config found. Run 'gh-symphony repo init' first.",
    };
  }

  const projectIds = global.projects ?? [];
  if (projectIds.length === 0) {
    return {
      kind: "no_projects",
      message:
        "No repository runtime config is configured. Run 'gh-symphony repo init' first.",
    };
  }

  const cwdRepository = await loadRepositoryProjectFromCwd(
    input.configDir,
    input.cwd ?? process.cwd(),
    projectIds
  );
  if (cwdRepository) {
    return { kind: "resolved", ...cwdRepository };
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
        message: `Active project "${global.activeProject}" is configured in config.json but its project config is missing. ${projectConfigRemediation()}`,
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
        message: missingProjectConfigMessage(projectId),
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
    message: diagnosticProjectRequiredMessage(),
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

  const cwdRepository = await loadRepositoryProjectFromCwd(
    input.configDir,
    input.cwd ?? process.cwd(),
    projectIds
  );
  if (cwdRepository) {
    return cwdRepository.projectConfig;
  }

  if (projectIds.length === 1) {
    return loadProjectConfig(input.configDir, projectIds[0]!);
  }

  if (global?.activeProject) {
    return loadProjectConfig(input.configDir, global.activeProject);
  }

  if (!isInteractiveTerminal()) {
    writeCliError({
      code: "missing_repository_runtime_config",
      message: explicitProjectRequiredMessage().trimEnd(),
      json: input.json,
    });
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

export function handleMissingManagedProjectConfig(options?: {
  json?: boolean;
  message?: string;
}): void {
  if (process.exitCode) {
    return;
  }

  writeCliError({
    code: "missing_repository_runtime_config",
    message:
      options?.message ??
      "No repository runtime config found. Run 'gh-symphony repo init' first.",
    json: options?.json,
  });
}

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  OrchestratorProjectConfig,
  OrchestratorTrackerSettingValue,
  RepositoryRef,
} from "@gh-symphony/core";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".gh-symphony");
export const CONFIG_FILE = "config.json";
export const DAEMON_PID_FILE = "daemon.pid";
export const ORCHESTRATOR_LOG_FILE = "orchestrator.log";
export const HTTP_STATUS_FILE = "http.json";
export const REPO_RUNTIME_DIR = join(".runtime", "orchestrator");

export type CliGlobalConfig = {
  activeProject: string | null;
  projects: string[];
};

export type CliProjectTrackerSettings = Record<
  string,
  OrchestratorTrackerSettingValue
> & {
  projectId?: string;
  repository?: string;
  assignedOnly?: boolean;
  timeoutMs?: number;
};

export type CliProjectConfig = Omit<
  OrchestratorProjectConfig,
  "repository" | "tracker"
> & {
  displayName?: string;
  repository?: RepositoryRef;
  tracker: Omit<OrchestratorProjectConfig["tracker"], "settings"> & {
    settings?: CliProjectTrackerSettings;
  };
};

export type StateRole = "active" | "wait" | "terminal";

export type StateMapping = { role: StateRole; goal?: string };

export function resolveConfigDir(override?: string): string {
  if (override) {
    return override;
  }
  if (process.env.GH_SYMPHONY_CONFIG_DIR) {
    return process.env.GH_SYMPHONY_CONFIG_DIR;
  }

  const repoRuntimeDir = resolve(process.cwd(), REPO_RUNTIME_DIR);
  if (existsSync(configFilePath(repoRuntimeDir))) {
    return repoRuntimeDir;
  }

  return DEFAULT_CONFIG_DIR;
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE);
}

export function projectConfigDir(configDir: string, projectId: string): string {
  return join(configDir, "projects", projectId);
}

export function projectConfigPath(
  configDir: string,
  projectId: string
): string {
  return join(projectConfigDir(configDir, projectId), "project.json");
}

export function daemonPidPath(configDir: string, projectId: string): string {
  return join(projectConfigDir(configDir, projectId), DAEMON_PID_FILE);
}

export function orchestratorLogPath(
  configDir: string,
  projectId: string
): string {
  return join(projectConfigDir(configDir, projectId), ORCHESTRATOR_LOG_FILE);
}

export function orchestratorWorkspaceRuntimeDir(
  configDir: string,
  projectId: string
): string {
  return join(configDir, "orchestrator", "workspaces", projectId);
}

export function httpStatusPath(configDir: string, projectId: string): string {
  return join(
    orchestratorWorkspaceRuntimeDir(configDir, projectId),
    HTTP_STATUS_FILE
  );
}

export async function loadGlobalConfig(
  configDir: string
): Promise<CliGlobalConfig | null> {
  const raw = await readJsonFile<Partial<CliGlobalConfig>>(
    configFilePath(configDir)
  );
  if (!raw) {
    return null;
  }

  return {
    activeProject:
      typeof raw.activeProject === "string" ? raw.activeProject : null,
    projects: Array.isArray(raw.projects)
      ? raw.projects.filter(
          (projectId): projectId is string => typeof projectId === "string"
        )
      : [],
  };
}

export async function saveGlobalConfig(
  configDir: string,
  config: CliGlobalConfig
): Promise<void> {
  await writeJsonFile(configFilePath(configDir), config);
}

export async function loadProjectConfig(
  configDir: string,
  projectId: string
): Promise<CliProjectConfig | null> {
  return readJsonFile<CliProjectConfig>(
    projectConfigPath(configDir, projectId)
  );
}

export async function saveProjectConfig(
  configDir: string,
  projectId: string,
  config: CliProjectConfig
): Promise<void> {
  await writeJsonFile(projectConfigPath(configDir, projectId), config);
}

export async function loadActiveProjectConfig(
  configDir: string
): Promise<CliProjectConfig | null> {
  const global = await loadGlobalConfig(configDir);
  if (!global?.activeProject) {
    return null;
  }
  return loadProjectConfig(configDir, global.activeProject);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temporaryPath, path);
}

function isFileMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

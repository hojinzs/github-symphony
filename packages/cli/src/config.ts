import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorProjectConfig } from "@gh-symphony/core";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".gh-symphony");
export const CONFIG_FILE = "config.json";
export const DAEMON_PID_FILE = "daemon.pid";
export const LOGS_DIR = "logs";

export type CliGlobalConfig = {
  activeProject: string | null;
  projects: string[];
};

export type CliProjectTrackerSettings = Record<string, string | boolean> & {
  projectId?: string;
  assignedOnly?: boolean;
};

export type CliProjectConfig = Omit<OrchestratorProjectConfig, "tracker"> & {
  tracker: Omit<OrchestratorProjectConfig["tracker"], "settings"> & {
    settings?: CliProjectTrackerSettings;
  };
};

export type StateRole = "active" | "wait" | "terminal";

export type StateMapping = { role: StateRole; goal?: string };

export function resolveConfigDir(override?: string): string {
  return override ?? process.env.GH_SYMPHONY_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE);
}

export function projectConfigDir(configDir: string, projectId: string): string {
  return join(configDir, "projects", projectId);
}

export function projectConfigPath(configDir: string, projectId: string): string {
  return join(projectConfigDir(configDir, projectId), "project.json");
}

export function daemonPidPath(configDir: string): string {
  return join(configDir, DAEMON_PID_FILE);
}

export function logsDir(configDir: string): string {
  return join(configDir, LOGS_DIR);
}

export function orchestratorLogPath(configDir: string): string {
  return join(logsDir(configDir), "orchestrator.log");
}

export async function loadGlobalConfig(
  configDir: string
): Promise<CliGlobalConfig | null> {
  return readJsonFile<CliGlobalConfig>(configFilePath(configDir));
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
  return readJsonFile<CliProjectConfig>(projectConfigPath(configDir, projectId));
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

async function writeJsonFile(path: string, value: unknown): Promise<void> {
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

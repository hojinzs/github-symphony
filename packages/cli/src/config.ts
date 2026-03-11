import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  OrchestratorWorkspaceConfig,
  WorkflowLifecycleConfig,
} from "@gh-symphony/core";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".gh-symphony");
export const CONFIG_FILE = "config.json";
export const DAEMON_PID_FILE = "daemon.pid";
export const LOGS_DIR = "logs";

export type CliGlobalConfig = {
  activeWorkspace: string | null;
  token: string | null;
  workspaces: string[];
};

export type CliWorkspaceConfig = OrchestratorWorkspaceConfig & {
  workflowMapping?: WorkflowMappingConfig;
};

export type WorkflowMappingConfig = {
  stateFieldName: string;
  columnRoles: Record<string, ColumnRole>;
  humanReviewMode: HumanReviewMode;
  lifecycle: WorkflowLifecycleConfig;
};

export type ColumnRole =
  | "trigger"
  | "working"
  | "human-review"
  | "done"
  | "ignored";

export type HumanReviewMode = "plan-and-pr" | "plan-only" | "pr-only" | "none";

export function resolveConfigDir(override?: string): string {
  return override ?? process.env.GH_SYMPHONY_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE);
}

export function workspaceConfigDir(
  configDir: string,
  workspaceId: string
): string {
  return join(configDir, "workspaces", workspaceId);
}

export function workspaceConfigPath(
  configDir: string,
  workspaceId: string
): string {
  return join(workspaceConfigDir(configDir, workspaceId), "workspace.json");
}

export function workflowMappingPath(
  configDir: string,
  workspaceId: string
): string {
  return join(
    workspaceConfigDir(configDir, workspaceId),
    "workflow-mapping.json"
  );
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

export async function loadWorkspaceConfig(
  configDir: string,
  workspaceId: string
): Promise<CliWorkspaceConfig | null> {
  return readJsonFile<CliWorkspaceConfig>(
    workspaceConfigPath(configDir, workspaceId)
  );
}

export async function saveWorkspaceConfig(
  configDir: string,
  workspaceId: string,
  config: CliWorkspaceConfig
): Promise<void> {
  await writeJsonFile(workspaceConfigPath(configDir, workspaceId), config);
}

export async function loadWorkflowMapping(
  configDir: string,
  workspaceId: string
): Promise<WorkflowMappingConfig | null> {
  return readJsonFile<WorkflowMappingConfig>(
    workflowMappingPath(configDir, workspaceId)
  );
}

export async function saveWorkflowMapping(
  configDir: string,
  workspaceId: string,
  mapping: WorkflowMappingConfig
): Promise<void> {
  await writeJsonFile(workflowMappingPath(configDir, workspaceId), mapping);
}

export async function loadActiveWorkspaceConfig(
  configDir: string
): Promise<CliWorkspaceConfig | null> {
  const global = await loadGlobalConfig(configDir);
  if (!global?.activeWorkspace) {
    return null;
  }
  return loadWorkspaceConfig(configDir, global.activeWorkspace);
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

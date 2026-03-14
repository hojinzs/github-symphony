import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  OrchestratorTenantConfig,
  WorkflowLifecycleConfig,
} from "@gh-symphony/core";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".gh-symphony");
export const CONFIG_FILE = "config.json";
export const DAEMON_PID_FILE = "daemon.pid";
export const LOGS_DIR = "logs";

export type CliGlobalConfig = {
  activeTenant: string | null;
  tenants: string[];
};

export type CliTenantConfig = OrchestratorTenantConfig & {
  workflowMapping?: WorkflowStateConfig;
};

export type StateRole = "active" | "wait" | "terminal";

export type StateMapping = { role: StateRole; goal?: string };

export type WorkflowStateConfig = {
  stateFieldName: string;
  mappings: Record<string, StateMapping>;
  lifecycle: WorkflowLifecycleConfig;
};

export function resolveConfigDir(override?: string): string {
  return override ?? process.env.GH_SYMPHONY_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE);
}

export function tenantConfigDir(configDir: string, tenantId: string): string {
  return join(configDir, "tenants", tenantId);
}

export function tenantConfigPath(configDir: string, tenantId: string): string {
  return join(tenantConfigDir(configDir, tenantId), "tenant.json");
}

export function workflowMappingPath(
  configDir: string,
  tenantId: string
): string {
  return join(tenantConfigDir(configDir, tenantId), "workflow-mapping.json");
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

export async function loadTenantConfig(
  configDir: string,
  tenantId: string
): Promise<CliTenantConfig | null> {
  return readJsonFile<CliTenantConfig>(tenantConfigPath(configDir, tenantId));
}

export async function saveTenantConfig(
  configDir: string,
  tenantId: string,
  config: CliTenantConfig
): Promise<void> {
  await writeJsonFile(tenantConfigPath(configDir, tenantId), config);
}

export async function loadWorkflowMapping(
  configDir: string,
  tenantId: string
): Promise<WorkflowStateConfig | null> {
  return readJsonFile<WorkflowStateConfig>(
    workflowMappingPath(configDir, tenantId)
  );
}

export async function saveWorkflowMapping(
  configDir: string,
  tenantId: string,
  mapping: WorkflowStateConfig
): Promise<void> {
  await writeJsonFile(workflowMappingPath(configDir, tenantId), mapping);
}

export async function loadActiveTenantConfig(
  configDir: string
): Promise<CliTenantConfig | null> {
  const global = await loadGlobalConfig(configDir);
  if (!global?.activeTenant) {
    return null;
  }
  return loadTenantConfig(configDir, global.activeTenant);
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

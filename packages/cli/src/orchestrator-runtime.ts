import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadGlobalConfig,
  loadWorkspaceConfig,
  type CliWorkspaceConfig,
} from "./config.js";

export function resolveRuntimeRoot(configDir: string): string {
  return resolve(configDir);
}

export async function resolveWorkspaceConfig(
  configDir: string,
  requestedWorkspaceId?: string
): Promise<CliWorkspaceConfig | null> {
  if (requestedWorkspaceId) {
    return loadWorkspaceConfig(configDir, requestedWorkspaceId);
  }

  const global = await loadGlobalConfig(configDir);
  if (!global?.activeWorkspace) {
    return null;
  }

  return loadWorkspaceConfig(configDir, global.activeWorkspace);
}

export function orchestratorWorkspaceConfigPath(
  runtimeRoot: string,
  workspaceId: string
): string {
  return join(
    runtimeRoot,
    "orchestrator",
    "workspaces",
    workspaceId,
    "config.json"
  );
}

export async function syncWorkspaceToRuntime(
  configDir: string,
  workspaceConfig: CliWorkspaceConfig
): Promise<string> {
  const runtimeRoot = resolveRuntimeRoot(configDir);
  const configPath = orchestratorWorkspaceConfigPath(
    runtimeRoot,
    workspaceConfig.workspaceId
  );
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(workspaceConfig, null, 2) + "\n");
  return runtimeRoot;
}

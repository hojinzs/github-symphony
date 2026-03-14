import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadGlobalConfig,
  loadProjectConfig,
  type CliProjectConfig,
} from "./config.js";

export function resolveRuntimeRoot(configDir: string): string {
  return resolve(configDir);
}

export async function resolveProjectConfig(
  configDir: string,
  requestedProjectId?: string
): Promise<CliProjectConfig | null> {
  if (requestedProjectId) {
    return loadProjectConfig(configDir, requestedProjectId);
  }

  const global = await loadGlobalConfig(configDir);
  if (!global?.activeProject) {
    return null;
  }

  return loadProjectConfig(configDir, global.activeProject);
}

export function orchestratorProjectConfigPath(
  runtimeRoot: string,
  projectId: string
): string {
  return join(
    runtimeRoot,
    "orchestrator",
    "projects",
    projectId,
    "config.json"
  );
}

export async function syncProjectToRuntime(
  configDir: string,
  projectConfig: CliProjectConfig
): Promise<string> {
  const runtimeRoot = resolveRuntimeRoot(configDir);
  const configPath = orchestratorProjectConfigPath(
    runtimeRoot,
    projectConfig.projectId
  );
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(projectConfig, null, 2) + "\n");

  return runtimeRoot;
}

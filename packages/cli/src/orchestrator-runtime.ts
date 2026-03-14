import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadGlobalConfig,
  loadTenantConfig,
  type CliTenantConfig,
} from "./config.js";

export function resolveRuntimeRoot(configDir: string): string {
  return resolve(configDir);
}

export async function resolveTenantConfig(
  configDir: string,
  requestedTenantId?: string
): Promise<CliTenantConfig | null> {
  if (requestedTenantId) {
    return loadTenantConfig(configDir, requestedTenantId);
  }

  const global = await loadGlobalConfig(configDir);
  if (!global?.activeTenant) {
    return null;
  }

  return loadTenantConfig(configDir, global.activeTenant);
}

export function orchestratorTenantConfigPath(
  runtimeRoot: string,
  tenantId: string
): string {
  return join(
    runtimeRoot,
    "orchestrator",
    "tenants",
    tenantId,
    "config.json"
  );
}

export async function syncTenantToRuntime(
  configDir: string,
  tenantConfig: CliTenantConfig
): Promise<string> {
  const runtimeRoot = resolveRuntimeRoot(configDir);
  const configPath = orchestratorTenantConfigPath(
    runtimeRoot,
    tenantConfig.tenantId
  );
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(tenantConfig, null, 2) + "\n");

  return runtimeRoot;
}

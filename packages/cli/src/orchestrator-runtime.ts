import { copyFile, mkdir, writeFile } from "node:fs/promises";
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

  // Copy tenant WORKFLOW.md to runtime if it exists
  const workflowSrc = join(
    configDir,
    "tenants",
    tenantConfig.tenantId,
    "WORKFLOW.md"
  );
  const workflowDst = join(dirname(configPath), "WORKFLOW.md");
  try {
    await copyFile(workflowSrc, workflowDst);
  } catch (error: unknown) {
    // ENOENT is expected for tenants created before WORKFLOW.md scaffolding
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  return runtimeRoot;
}

import { join } from "node:path";
import { readEnvFile } from "@gh-symphony/core";
import type { OrchestratorProjectConfig } from "@gh-symphony/core";

/**
 * Matches the daemon's managed-project directory layout and environment
 * precedence for CLI consumers that inspect a configured workflow.
 */
export function resolveManagedProjectEnvironment(
  projectConfig: Pick<OrchestratorProjectConfig, "projectDir" | "projectId">,
  runtimeRoot: string
): NodeJS.ProcessEnv {
  const projectDirectory =
    projectConfig.projectDir ??
    join(runtimeRoot, "projects", encodeURIComponent(projectConfig.projectId));
  const envPath = join(projectDirectory, ".env");

  try {
    return {
      ...readEnvFile(envPath),
      ...process.env,
    };
  } catch {
    // The daemon warns and continues when the managed project env cannot be
    // read; diagnostics and preflight must not become stricter than runtime.
    return process.env;
  }
}

export function resolveManagedProjectDirectory(
  projectConfig: Pick<OrchestratorProjectConfig, "projectDir" | "projectId">,
  runtimeRoot: string
): string {
  return (
    projectConfig.projectDir ??
    join(runtimeRoot, "projects", encodeURIComponent(projectConfig.projectId))
  );
}

/** Reads only the managed project's .env, without daemon-level fallbacks. */
export function resolveManagedProjectFileEnvironment(
  projectConfig: Pick<OrchestratorProjectConfig, "projectDir" | "projectId">,
  runtimeRoot: string
): Record<string, string> {
  try {
    return readEnvFile(
      join(resolveManagedProjectDirectory(projectConfig, runtimeRoot), ".env")
    );
  } catch {
    return {};
  }
}

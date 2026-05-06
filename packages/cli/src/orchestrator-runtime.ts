import { resolve } from "node:path";

export function resolveRuntimeRoot(configDir: string): string {
  return resolve(configDir);
}

export function resolveRepoRuntimeRoot(repoDir = process.cwd()): string {
  return resolve(repoDir, ".runtime", "orchestrator");
}

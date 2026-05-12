import { resolve } from "node:path";
import { REPO_RUNTIME_DIR } from "./config.js";

export function resolveRuntimeRoot(configDir: string): string {
  return resolve(configDir);
}

export function resolveRepoRuntimeRoot(repoDir = process.cwd()): string {
  return resolve(repoDir, REPO_RUNTIME_DIR);
}

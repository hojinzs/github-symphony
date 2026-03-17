import { resolve } from "node:path";

export function resolveRuntimeRoot(configDir: string): string {
  return resolve(configDir);
}

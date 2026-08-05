import { resolve } from "node:path";
import { isPathWithinRoot } from "./path-safety.js";

export function resolveWorkspaceDirectory(
  workspaceRoot: string,
  workspaceId: string
): string {
  const normalizedRoot = resolve(workspaceRoot);
  const candidate = resolve(normalizedRoot, workspaceId);

  if (!isPathWithinRoot(normalizedRoot, candidate)) {
    throw new Error("Workspace path escapes the configured workspace root.");
  }

  return candidate;
}

export function assertRepositoryAllowed(
  targetRepositoryCloneUrl: string,
  allowedRepositoryCloneUrls: string[]
): void {
  if (!allowedRepositoryCloneUrls.includes(targetRepositoryCloneUrl)) {
    throw new Error(
      `Repository is not in the workspace allowlist: ${targetRepositoryCloneUrl}`
    );
  }
}

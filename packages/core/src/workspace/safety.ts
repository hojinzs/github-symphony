import { resolve } from "node:path";

export function resolveWorkspaceDirectory(
  workspaceRoot: string,
  workspaceId: string
): string {
  const normalizedRoot = resolve(workspaceRoot);
  const candidate = resolve(normalizedRoot, workspaceId);

  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error("Workspace path escapes the configured workspace root.");
  }

  return candidate;
}

export function assertRepositoryAllowed(
  targetRepositoryCloneUrl: string,
  allowedRepositoryCloneUrls: string[]
): void {
  if (!allowedRepositoryCloneUrls.includes(targetRepositoryCloneUrl)) {
    throw new Error(`Repository is not in the workspace allowlist: ${targetRepositoryCloneUrl}`);
  }
}

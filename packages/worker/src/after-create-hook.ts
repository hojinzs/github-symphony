import { mkdirSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveWorkspaceDirectory } from "@gh-symphony/core";

export type AfterCreateHookContext = {
  workspaceId: string;
  workspaceRoot: string;
  targetRepositoryCloneUrl: string;
};

export type PreparedAfterCreateHook = {
  scriptPath: string;
  workspaceDirectory: string;
  env: Record<string, string>;
};

export function buildAfterCreateHookScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

workspace_dir="\${WORKSPACE_DIR:?WORKSPACE_DIR is required}"
target_repo="\${TARGET_REPOSITORY_CLONE_URL:?TARGET_REPOSITORY_CLONE_URL is required}"

mkdir -p "$workspace_dir"
git clone "$target_repo" "$workspace_dir/repository"
`;
}

export async function prepareAfterCreateHook(
  hooksRoot: string,
  context: AfterCreateHookContext
): Promise<PreparedAfterCreateHook> {
  const workspaceDirectory = resolveWorkspaceDirectory(
    context.workspaceRoot,
    context.workspaceId
  );
  const scriptPath = join(resolve(hooksRoot), "after_create.sh");

  mkdirSync(resolve(hooksRoot), {
    recursive: true,
  });
  writeFileSync(scriptPath, buildAfterCreateHookScript(), "utf8");
  await chmod(scriptPath, 0o755);

  return {
    scriptPath,
    workspaceDirectory,
    env: {
      WORKSPACE_DIR: workspaceDirectory,
      TARGET_REPOSITORY_CLONE_URL: context.targetRepositoryCloneUrl,
    },
  };
}

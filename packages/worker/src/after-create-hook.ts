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
repository_dir="$workspace_dir/repository"

mkdir -p "$workspace_dir"
if [ -d "$repository_dir/.git" ]; then
  git -C "$repository_dir" pull --ff-only
  exit 0
fi

if [ -e "$repository_dir" ] && [ -n "$(ls -A "$repository_dir" 2>/dev/null)" ]; then
  echo "repository directory already exists and is not a git checkout: $repository_dir" >&2
  exit 1
fi

git clone "$target_repo" "$repository_dir"
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

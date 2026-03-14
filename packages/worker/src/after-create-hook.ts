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
if git -C "$repository_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  current_remote="$(git -C "$repository_dir" remote get-url origin 2>/dev/null || true)"
  if [ -n "$current_remote" ] && [ "$current_remote" != "$target_repo" ]; then
    rm -rf "$repository_dir"
  else
    if [ -n "$current_remote" ]; then
      git -C "$repository_dir" remote set-url origin "$target_repo"
    else
      git -C "$repository_dir" remote add origin "$target_repo"
    fi
    if current_branch="$(git -C "$repository_dir" symbolic-ref --quiet --short HEAD 2>/dev/null)"; then
      git -C "$repository_dir" pull --ff-only origin "$current_branch"
    else
      git -C "$repository_dir" fetch --prune origin
    fi
  exit 0
fi
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

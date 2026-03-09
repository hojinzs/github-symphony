import { mkdirSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertRepositoryAllowed,
  resolveWorkspaceDirectory
} from "@github-symphony/core";

export type AfterCreateHookContext = {
  workspaceId: string;
  workspaceRoot: string;
  targetRepositoryCloneUrl: string;
  allowedRepositoryCloneUrls: string[];
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
allowed_repos="\${WORKSPACE_ALLOWED_REPOSITORIES:?WORKSPACE_ALLOWED_REPOSITORIES is required}"

case ",$allowed_repos," in
  *,"$target_repo",*) ;;
  *)
    echo "Repository is not allowed: $target_repo" >&2
    exit 1
    ;;
esac

mkdir -p "$workspace_dir"
git clone "$target_repo" "$workspace_dir/repository"
`;
}

export async function prepareAfterCreateHook(
  hooksRoot: string,
  context: AfterCreateHookContext
): Promise<PreparedAfterCreateHook> {
  assertRepositoryAllowed(
    context.targetRepositoryCloneUrl,
    context.allowedRepositoryCloneUrls
  );

  const workspaceDirectory = resolveWorkspaceDirectory(
    context.workspaceRoot,
    context.workspaceId
  );
  const scriptPath = join(resolve(hooksRoot), "after_create.sh");

  mkdirSync(resolve(hooksRoot), {
    recursive: true
  });
  writeFileSync(scriptPath, buildAfterCreateHookScript(), "utf8");
  await chmod(scriptPath, 0o755);

  return {
    scriptPath,
    workspaceDirectory,
    env: {
      WORKSPACE_DIR: workspaceDirectory,
      TARGET_REPOSITORY_CLONE_URL: context.targetRepositoryCloneUrl,
      WORKSPACE_ALLOWED_REPOSITORIES: context.allowedRepositoryCloneUrls.join(",")
    }
  };
}

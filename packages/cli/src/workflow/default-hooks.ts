export const DEFAULT_AFTER_CREATE_HOOK_PATH = "hooks/after_create.sh";
export const DEFAULT_AFTER_CREATE_HOOK_LABEL = "Workspace hook scaffold";
export const DEFAULT_AFTER_CREATE_HOOK_COMMENT =
  "scaffolded by workflow init; customize this script for repository setup";

export const DEFAULT_AFTER_CREATE_HOOK_CONTENT = `#!/usr/bin/env bash
set -euo pipefail

# Customize this hook to prepare a freshly created workspace.
# This scaffold is intentionally a no-op so generated workflows run cleanly.
exit 0
`;

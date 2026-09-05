export const DEFAULT_AFTER_CREATE_HOOK_PATH = "hooks/after_create.sh";
export const DEFAULT_AFTER_CREATE_HOOK_LABEL = "Workspace population hook";
export const DEFAULT_AFTER_CREATE_HOOK_COMMENT =
  "clones the repository and checks out the issue branch; customize as needed";

export const LEGACY_NOOP_AFTER_CREATE_HOOK_CONTENT = `#!/usr/bin/env bash
set -euo pipefail

# Customize this hook to prepare a freshly created workspace.
# This scaffold is intentionally a no-op so generated workflows run cleanly.
exit 0
`;

export const DEFAULT_AFTER_CREATE_HOOK_CONTENT = `#!/usr/bin/env bash
set -euo pipefail

: "\${SYMPHONY_REPOSITORY_CLONE_URL:?SYMPHONY_REPOSITORY_CLONE_URL is required}"
: "\${SYMPHONY_REPOSITORY_PATH:?SYMPHONY_REPOSITORY_PATH is required}"
: "\${SYMPHONY_ASSIGNED_BRANCH:?SYMPHONY_ASSIGNED_BRANCH is required}"

git clone --filter=blob:none "$SYMPHONY_REPOSITORY_CLONE_URL" "$SYMPHONY_REPOSITORY_PATH"
git -C "$SYMPHONY_REPOSITORY_PATH" checkout -B "$SYMPHONY_ASSIGNED_BRANCH" \
  "origin/\${SYMPHONY_BASE_BRANCH:-HEAD}"
`;

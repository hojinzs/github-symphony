#!/usr/bin/env bash
# gh-symphony `hooks.after_create` — populates a fresh issue workspace, then
# installs and builds the checkout. The daemon host must
# export SYMPHONY_ALLOW_WORKFLOW_HOOKS=1 for hooks to execute; otherwise the
# worker installs dependencies itself per WORKFLOW.md Runtime Contract 8.
set -euo pipefail

: "${SYMPHONY_REPOSITORY_CLONE_URL:?SYMPHONY_REPOSITORY_CLONE_URL is required}"
: "${SYMPHONY_REPOSITORY_PATH:?SYMPHONY_REPOSITORY_PATH is required}"
: "${SYMPHONY_ASSIGNED_BRANCH:?SYMPHONY_ASSIGNED_BRANCH is required}"

git clone --filter=blob:none "$SYMPHONY_REPOSITORY_CLONE_URL" "$SYMPHONY_REPOSITORY_PATH"
git -C "$SYMPHONY_REPOSITORY_PATH" checkout -B "$SYMPHONY_ASSIGNED_BRANCH" \
  "${SYMPHONY_BASE_BRANCH:-origin/HEAD}"

cd "$SYMPHONY_REPOSITORY_PATH"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

pnpm install --frozen-lockfile
pnpm build

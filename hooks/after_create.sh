#!/usr/bin/env bash
# gh-symphony `hooks.after_create` — runs once when a fresh issue worktree is
# populated (SYMPHONY_REPOSITORY_PATH is the checkout). The daemon host must
# export SYMPHONY_ALLOW_WORKFLOW_HOOKS=1 for hooks to execute; otherwise the
# worker installs dependencies itself per WORKFLOW.md Runtime Contract 8.
set -euo pipefail

cd "${SYMPHONY_REPOSITORY_PATH:-$(pwd)}"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

pnpm install --frozen-lockfile
pnpm build

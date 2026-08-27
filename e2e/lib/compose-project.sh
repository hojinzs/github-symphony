#!/usr/bin/env bash

# Shared Docker Compose isolation for E2E runners. A path-derived name keeps
# concurrent worktrees separate while allowing an explicit project to be used
# for debugging.

e2e_compose_project_name() {
  local worktree_path="$1"
  local path_hash
  path_hash=$(printf '%s' "$worktree_path" | shasum -a 256 | cut -c1-12)
  printf 'symphony-e2e-%s' "$path_hash"
}

configure_e2e_compose_project() {
  local worktree_path="$1"
  export COMPOSE_PROJECT_NAME="${SYMPHONY_E2E_PROJECT:-$(e2e_compose_project_name "$worktree_path")}"
  export SYMPHONY_E2E_IMAGE="${SYMPHONY_E2E_IMAGE:-${COMPOSE_PROJECT_NAME}:e2e}"
}

assert_e2e_project_is_available() {
  local compose_file="$1"
  local running
  running=$(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$compose_file" ps -q 2>/dev/null || true)
  if [ -n "$running" ]; then
    echo "[e2e] Compose project '${COMPOSE_PROJECT_NAME}' is already running. Set SYMPHONY_E2E_PROJECT to a unique value or stop it first." >&2
    return 1
  fi
}

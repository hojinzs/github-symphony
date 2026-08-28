#!/usr/bin/env bash

# Shared Docker Compose isolation for E2E runners. A path-derived name keeps
# concurrent worktrees separate while allowing an explicit project to be used
# for debugging.

e2e_path_hash() {
  local worktree_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$worktree_path" | sha256sum | cut -c1-12
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$worktree_path" | shasum -a 256 | cut -c1-12
  else
    echo '[e2e] sha256sum or shasum is required to derive the Compose project name' >&2
    return 1
  fi
}

e2e_compose_project_name() {
  printf 'symphony-e2e-%s' "$(e2e_path_hash "$1")"
}

e2e_compose_port() {
  local path_hash decimal_port
  path_hash=$(e2e_path_hash "$1")
  decimal_port=$((16#${path_hash:0:4}))
  printf '%s' "$((20000 + decimal_port % 10000))"
}

configure_e2e_compose_project() {
  local worktree_path="$1"
  export COMPOSE_PROJECT_NAME="${SYMPHONY_E2E_PROJECT:-$(e2e_compose_project_name "$worktree_path")}"
  if [ -n "${SYMPHONY_E2E_IMAGE:-}" ]; then
    export E2E_IMAGE_IS_DERIVED=false
  else
    export SYMPHONY_E2E_IMAGE="${COMPOSE_PROJECT_NAME}:e2e"
    export E2E_IMAGE_IS_DERIVED=true
  fi
  export SYMPHONY_E2E_PORT="${SYMPHONY_E2E_PORT:-$(e2e_compose_port "$worktree_path")}"
}

assert_e2e_project_is_available() {
  local compose_file="$1"
  local project_name="${2:-$COMPOSE_PROJECT_NAME}"
  local running
  running=$(docker compose --project-name "$project_name" -f "$compose_file" ps -q 2>/dev/null || true)
  if [ -n "$running" ]; then
    echo "[e2e] Compose project '${project_name}' is already running. Set SYMPHONY_E2E_PROJECT to a unique value or stop it first." >&2
    return 1
  fi
}

remove_e2e_compose_image() {
  [ "${E2E_IMAGE_IS_DERIVED:-true}" = true ] || return 0
  docker image rm "$SYMPHONY_E2E_IMAGE" >/dev/null 2>&1 || true
}

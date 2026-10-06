#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$ROOT_DIR"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$ROOT_DIR/docker-compose.e2e.yml")
assert_docker_runtime_is_available
assert_e2e_project_is_available "$ROOT_DIR/docker-compose.e2e.yml"
cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  remove_e2e_compose_image
}
trap cleanup EXIT
cd "$ROOT_DIR"
"${COMPOSE[@]}" run --build --rm --no-deps --entrypoint node symphony-e2e /app/e2e/fleet-enrollment-e2e.mjs
"${COMPOSE[@]}" run --rm --no-deps --entrypoint node symphony-e2e /app/e2e/fleet-enrollment-mutations.mjs

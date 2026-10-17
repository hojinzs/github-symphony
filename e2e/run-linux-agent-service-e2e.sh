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
"${COMPOSE[@]}" build symphony-e2e
"${COMPOSE[@]}" run --rm --no-deps --entrypoint bash symphony-e2e -lc '
set -euo pipefail
node --test /app/e2e/lib/json-journal.test.mjs
node /app/e2e/linux-agent-service-e2e.mjs --simulate
node /app/e2e/run-linux-agent-service-probes.mjs --simulate
'

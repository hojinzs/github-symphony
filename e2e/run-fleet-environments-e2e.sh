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
"${COMPOSE[@]}" run --build --rm --no-deps --entrypoint node symphony-e2e /app/e2e/fleet-environments-e2e.mjs
"${COMPOSE[@]}" run --rm --no-deps --entrypoint node symphony-e2e /app/e2e/fleet-environments-mutations.mjs
if [[ "${C15_BROWSER:-0}" == "1" ]]; then
  "${COMPOSE[@]}" run --rm --no-deps --user root --entrypoint bash symphony-e2e -lc '
    set -euo pipefail
    apt-get update -qq
    apt-get install -y -qq chromium >/dev/null
    npm --prefix /tmp/c15-browser install playwright --no-save --ignore-scripts >/dev/null
    export C15_PLAYWRIGHT_MODULE=/tmp/c15-browser/node_modules/playwright/index.mjs
    export C15_CHROME=/usr/bin/chromium
    node /app/e2e/fleet-environments-browser.mjs
    node /app/e2e/fleet-environments-mutations.mjs --browser
  '
fi

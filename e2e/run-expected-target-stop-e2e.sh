#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$ROOT_DIR"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml)
cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  remove_e2e_compose_image
}
assert_docker_runtime_is_available
assert_e2e_project_is_available docker-compose.e2e.yml
trap cleanup EXIT
"${COMPOSE[@]}" build symphony-e2e >/dev/null
"${COMPOSE[@]}" run --rm --no-deps --entrypoint bash symphony-e2e -lc '
set -euo pipefail
node /app/e2e/expected-target-stop.mjs
if EXPECTED_STOP_PLANT_FORBIDDEN=1 node /app/e2e/expected-target-stop.mjs >/tmp/expected-stop-probe.log 2>&1; then
  echo "forbidden-record probe unexpectedly passed" >&2
  exit 1
fi
grep -q "CP-08: replacement B ownership records must be preserved" /tmp/expected-stop-probe.log
echo "CP-08 forbidden-record assertion probe failed as required"
'

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
node /app/e2e/bounded-read-contract.mjs
for probe in chunk reset metadata missing containment; do
  if BOUNDED_READ_PLANT_FORBIDDEN="$probe" node /app/e2e/bounded-read-contract.mjs >"/tmp/bounded-read-$probe.log" 2>&1; then
    echo "forbidden $probe probe unexpectedly passed" >&2
    exit 1
  fi
  case "$probe" in
    chunk) assertion="CP-12 log wire text limited to 256 KiB" ;;
    reset) assertion="CP-12 rotation returns explicit reset" ;;
    metadata) assertion="CP-15 metadata excludes management credentials and raw errors" ;;
    missing) assertion="CP-12 missing log never reports empty success" ;;
    containment) assertion="CP-12 symlink escape rejected" ;;
  esac
  grep -q "$assertion" "/tmp/bounded-read-$probe.log"
  echo "$probe assertion reached and failed as required"
done
'

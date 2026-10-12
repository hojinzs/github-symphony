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
node /app/e2e/agent-transport-e2e.mjs
for probe in package premature exclusive sequence continuity credential; do
  if AGENT_TRANSPORT_PLANT_FORBIDDEN="$probe" node /app/e2e/agent-transport-e2e.mjs >"/tmp/c05-$probe.log" 2>&1; then
    echo "forbidden $probe unexpectedly passed" >&2
    exit 1
  fi
  case "$probe" in
    package) assertion="pack includes typed foreground entry" ;;
    premature) assertion="CP-21 exchange alone awaits first signal" ;;
    exclusive) assertion="CP-10 live second session rejected" ;;
    sequence) assertion="CP-10 older observation cannot replace projection" ;;
    continuity) assertion="CP-05 disconnect preserves orchestrator" ;;
    credential) assertion="credential absent from child diagnostics" ;;
  esac
  if ! grep -Fq "reached: $assertion" "/tmp/c05-$probe.log" ||
     ! grep -Fq "AssertionError" "/tmp/c05-$probe.log"; then
    echo "$probe did not fail at its reached assertion" >&2
    tail -n 40 "/tmp/c05-$probe.log" >&2
    exit 1
  fi
  echo "$probe assertion reached and failed as required"
done
'

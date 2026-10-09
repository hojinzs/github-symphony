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
"${COMPOSE[@]}" run --build --rm --no-deps --entrypoint node symphony-e2e /app/e2e/otlp-lifecycle-contract.mjs
for probe in pending-disable secret-diagnostic; do
  output=$(mktemp)
  if "${COMPOSE[@]}" run --rm --no-deps --entrypoint node symphony-e2e /app/e2e/otlp-lifecycle-contract.mjs "--probe=$probe" >"$output" 2>&1; then
    cat "$output"; rm -f "$output"; echo "Forbidden-condition probe unexpectedly passed: $probe" >&2; exit 1
  fi
  case "$probe" in
    pending-disable) marker='reached: pending disable' ;;
    secret-diagnostic) marker='reached: secret-free output' ;;
  esac
  rg -F "$marker" "$output"
  rg -F 'AssertionError' "$output"
  rm -f "$output"
done

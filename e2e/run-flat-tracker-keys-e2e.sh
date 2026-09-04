#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$ROOT_DIR"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml)

cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  remove_e2e_compose_image
}

assert_docker_runtime_is_available
trap cleanup EXIT

set +e
output=$("${COMPOSE[@]}" run --build --rm --no-deps --entrypoint sh symphony-e2e -lc '
  workflow=/tmp/flat-tracker-WORKFLOW.md
  printf "%s\\n" \
    "---" \
    "tracker:" \
    "  kind: github-project" \
    "  project_id: PVT_test" \
    "codex:" \
    "  command: fake-agent" \
    "---" \
    "Prompt" > "$workflow"
  node /app/packages/cli/dist/index.js workflow validate --file "$workflow" --json
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "Expected workflow validation to reject a flat tracker key." >&2
    exit 64
  fi
  exit 0
' 2>&1)
status=$?
set -e

printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  exit "$status"
fi
grep -F '"code": "workflow_deprecated_key"' <<<"$output" >/dev/null
grep -F '"path": "tracker.project_id"' <<<"$output" >/dev/null

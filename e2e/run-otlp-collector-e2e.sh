#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$ROOT_DIR"
assert_docker_runtime_is_available
assert_e2e_project_is_available "$ROOT_DIR/docker-compose.e2e.yml"
export OTLP_EVIDENCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/symphony-otlp-evidence.XXXXXX")"
chmod 777 "$OTLP_EVIDENCE_DIR"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$ROOT_DIR/docker-compose.e2e.yml" -f "$ROOT_DIR/docker-compose.e2e.otlp.yml")
cleanup() {
  "${COMPOSE[@]}" images --format json > "$OTLP_EVIDENCE_DIR/images.json" 2>/dev/null || true
  "${COMPOSE[@]}" logs --no-color collector > "$OTLP_EVIDENCE_DIR/collector.log" 2>&1 || true
  docker rm -f "${COMPOSE_PROJECT_NAME}-otlp-driver" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  remove_e2e_compose_image
  echo "OT-14 evidence: $OTLP_EVIDENCE_DIR"
}
trap cleanup EXIT
cd "$ROOT_DIR"
git rev-parse HEAD > "$OTLP_EVIDENCE_DIR/commit.txt"
cp e2e/otlp/collector.yaml "$OTLP_EVIDENCE_DIR/collector.yaml"
"${COMPOSE[@]}" build symphony-e2e >/dev/null
"${COMPOSE[@]}" up -d collector
"${COMPOSE[@]}" run -d --name "${COMPOSE_PROJECT_NAME}-otlp-driver" --no-deps --entrypoint sleep symphony-e2e infinity
# Retain a single container so all phases address the same project and durable history.
for phase in plain authenticated restart; do
  docker exec "${COMPOSE_PROJECT_NAME}-otlp-driver" node /app/e2e/otlp/wait-ready.mjs
  docker exec "${COMPOSE_PROJECT_NAME}-otlp-driver" node /app/e2e/otlp/dispatch.mjs "$phase"
done
"${COMPOSE[@]}" stop collector
# A stopped endpoint must not prevent durable dispatch or bounded shutdown.
docker exec "${COMPOSE_PROJECT_NAME}-otlp-driver" node /app/e2e/otlp/dispatch.mjs outage
node e2e/otlp/assert-receipt.mjs "$OTLP_EVIDENCE_DIR"
node e2e/otlp/receipt-mutations.mjs "$OTLP_EVIDENCE_DIR"
echo 'OT-14 Collector Docker E2E passed'

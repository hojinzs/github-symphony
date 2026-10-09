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
node /app/e2e/management-agent-contract.mjs
for probe in identity canonical locks replacement credential continuity; do
  if MANAGEMENT_AGENT_PLANT_FORBIDDEN="$probe" node /app/e2e/management-agent-contract.mjs >"/tmp/management-$probe.log" 2>&1; then
    echo "forbidden $probe probe unexpectedly passed" >&2
    exit 1
  fi
  case "$probe" in
    identity) assertion="CP-01 local identities qualify shared folder ID by environment" ;;
    canonical) assertion="CP-02 registered alias must retain canonical folder" ;;
    locks) assertion="CP-03 stop completion requires released locks" ;;
    replacement) assertion="CP-08 replacement ownership must survive recovered stop" ;;
    credential) assertion="CP-15 management credentials absent from project environment" ;;
    continuity) assertion="CP-14 removal and agent restart preserve orchestrator" ;;
  esac
  grep -q "$assertion" "/tmp/management-$probe.log"
  echo "$probe assertion reached and failed as required"
done
'

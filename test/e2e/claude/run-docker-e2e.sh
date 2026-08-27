#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root_dir"
source "$root_dir/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$root_dir"
e2e_compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml)
claude_compose=(docker compose --project-name "${COMPOSE_PROJECT_NAME}-claude" -f test/e2e/claude/docker-compose.yml)

http_api_token="${GH_SYMPHONY_HTTP_TOKEN:-e2e-http-token}"

mkdir -p evidence
echo "[]" > e2e/fixtures/issues.json

cleanup() {
  "${e2e_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  "${claude_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  echo "[]" > e2e/fixtures/issues.json
}
trap cleanup EXIT

assert_e2e_project_is_available docker-compose.e2e.yml
"${e2e_compose[@]}" up -d --build
(
  "${e2e_compose[@]}" exec -T symphony-e2e curl --fail --retry-all-errors --retry 20 --retry-delay 2 http://localhost:4680/healthz
  cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
  "${e2e_compose[@]}" exec -T symphony-e2e curl --fail -H "Authorization: Bearer ${http_api_token}" \
    -X POST http://localhost:4680/api/v1/refresh
  deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    state="$("${e2e_compose[@]}" exec -T symphony-e2e curl -fsS -H "Authorization: Bearer ${http_api_token}" \
      http://localhost:4680/api/v1/state)"
    if jq -e '.summary.activeRuns >= 1 or (.activeRuns | length) >= 1' >/dev/null <<<"$state"; then
      exit 0
    fi
    sleep 2
  done
  echo "Codex Docker E2E regression did not observe an active run" >&2
  exit 1
) &
codex_pid="$!"

"${claude_compose[@]}" up --build --abort-on-container-exit --exit-code-from claude-e2e &
claude_pid="$!"

codex_status=0
claude_status=0

wait "$codex_pid" || codex_status="$?"
wait "$claude_pid" || claude_status="$?"

if ((codex_status != 0 || claude_status != 0)); then
  echo "Docker E2E failed: codex=${codex_status} claude=${claude_status}" >&2
  exit 1
fi

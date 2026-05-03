#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root_dir"

mkdir -p evidence
echo "[]" > e2e/fixtures/issues.json

cleanup() {
  docker compose -f docker-compose.e2e.yml down --remove-orphans >/dev/null 2>&1 || true
  docker compose -f test/e2e/claude/docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
  echo "[]" > e2e/fixtures/issues.json
}
trap cleanup EXIT

docker compose -f docker-compose.e2e.yml up -d --build
codex_pid=""
(
  curl --fail --retry-all-errors --retry 20 --retry-delay 2 http://localhost:4680/healthz
  cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
  curl --fail -X POST http://localhost:4680/api/v1/refresh
  deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    state="$(curl -fsS http://localhost:4680/api/v1/state)"
    if jq -e '.summary.activeRuns >= 1 or (.activeRuns | length) >= 1' >/dev/null <<<"$state"; then
      exit 0
    fi
    sleep 2
  done
  echo "Codex Docker E2E regression did not observe an active run" >&2
  exit 1
) &
codex_pid="$!"

docker compose -f test/e2e/claude/docker-compose.yml up --build --abort-on-container-exit --exit-code-from claude-e2e &
claude_pid="$!"

wait "$codex_pid"
wait "$claude_pid"

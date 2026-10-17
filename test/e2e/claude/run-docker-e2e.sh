#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root_dir"
source "$root_dir/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$root_dir"
e2e_compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml)
claude_compose=(docker compose --project-name "${COMPOSE_PROJECT_NAME}-claude" -f test/e2e/claude/docker-compose.yml)

http_api_token="${GH_SYMPHONY_HTTP_TOKEN:-e2e-http-token}"

# Capture evidence before down removes exited containers. Do not inspect Config.Env:
# the HTTP token and any inherited runtime credentials must stay out of evidence.
collect_diagnostics() {
  local label="$1"
  shift
  "$@" ps --all > "$evidence_dir/$label-ps.log" 2>&1 || true
  "$@" logs --no-color --timestamps > "$evidence_dir/$label-container.log" 2>&1 || true
  local ids
  ids=$("$@" ps --all --quiet 2>>"$evidence_dir/$label-ps.log") || true
  if [ -n "$ids" ]; then
    # Compose emits one container ID per line; intentional word splitting.
    docker inspect --format '{{json .State}}' $ids > "$evidence_dir/$label-state.json" 2>&1 || true
    docker stats --no-stream $ids > "$evidence_dir/$label-stats.log" 2>&1 || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0)); then
    collect_diagnostics codex "${e2e_compose[@]}"
    collect_diagnostics claude "${claude_compose[@]}"
    docker events --since "$started_at" --until "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
      > "$evidence_dir/codex-events.log" 2>&1 || true
    echo "Docker E2E diagnostics: $evidence_dir" >&2
  fi
  "${e2e_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  remove_e2e_compose_image
  "${claude_compose[@]}" down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  echo "[]" > e2e/fixtures/issues.json
  exit "$status"
}
assert_docker_runtime_is_available
assert_e2e_project_is_available docker-compose.e2e.yml
assert_e2e_project_is_available test/e2e/claude/docker-compose.yml "${COMPOSE_PROJECT_NAME}-claude"
mkdir -p evidence
evidence_dir=$(mktemp -d "$root_dir/evidence/claude-docker.XXXXXX")
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "Docker E2E evidence: $evidence_dir"

echo "[]" > e2e/fixtures/issues.json
trap cleanup EXIT
# Keep the memory-heavy Claude image build out of the running Codex smoke leg.
# An exec status of 137 alone cannot establish whether the container was OOM-killed.
"${e2e_compose[@]}" build
"${claude_compose[@]}" build
"${e2e_compose[@]}" up -d --no-build

codex_request() {
  local phase="$1" status=0
  shift
  "${e2e_compose[@]}" exec -T symphony-e2e curl "$@" \
    > "$evidence_dir/$phase-response.log" 2> "$evidence_dir/$phase-error.log" || status=$?
  printf '%s=%s\n' "$phase" "$status" >> "$evidence_dir/codex-operations.log"
  if ((status != 0)); then
    echo "Codex Docker E2E $phase failed: status=$status" >&2
    cat "$evidence_dir/$phase-error.log" >&2
    collect_diagnostics "codex-$phase" "${e2e_compose[@]}"
  fi
  return "$status"
}
(
  codex_request health --fail --retry-all-errors --retry 20 --retry-delay 2 http://localhost:4680/healthz
  cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
  codex_request refresh --fail -H "Authorization: Bearer ${http_api_token}" \
    -X POST http://localhost:4680/api/v1/refresh
  deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    codex_request state -fsS -H "Authorization: Bearer ${http_api_token}" \
      http://localhost:4680/api/v1/state
    state=$(cat "$evidence_dir/state-response.log")
    if jq -e '.summary.activeRuns >= 1 or (.activeRuns | length) >= 1' >/dev/null <<<"$state"; then
      exit 0
    fi
    sleep 2
  done
  echo "Codex Docker E2E regression did not observe an active run" >&2
  exit 1
) &
codex_pid="$!"

"${claude_compose[@]}" up --no-build --abort-on-container-exit --exit-code-from claude-e2e &
claude_pid="$!"

codex_status=0
claude_status=0

wait "$codex_pid" || codex_status="$?"
wait "$claude_pid" || claude_status="$?"

if ((codex_status != 0 || claude_status != 0)); then
  echo "Docker E2E failed: codex=${codex_status} claude=${claude_status}" >&2
  exit 1
fi

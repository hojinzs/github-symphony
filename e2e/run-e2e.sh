#!/usr/bin/env bash
set -euo pipefail

# E2E Test Runner — polls the standalone dashboard until the scenario completes.
# Usage: ./e2e/run-e2e.sh [scenario] [timeout_seconds]
#   scenario: happy (default), fail, stall, slow, transition-race, api-progress, api-progress-unknown, prompt-phase, retry-attempt, non-dispatchable
#   timeout:  30 (default)

SCENARIO="${1:-happy}"
TIMEOUT="${2:-30}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$ROOT_DIR"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml)
HTTP_API_TOKEN="${GH_SYMPHONY_HTTP_TOKEN:-e2e-http-token}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[e2e]${NC} $*"; }
warn() { echo -e "${YELLOW}[e2e]${NC} $*"; }
fail() { echo -e "${RED}[e2e]${NC} $*"; }
orch_curl() {
  "${COMPOSE[@]}" exec -T symphony-e2e curl \
    -H "Authorization: Bearer ${HTTP_API_TOKEN}" "$@"
}
unauthenticated_orch_curl() {
  "${COMPOSE[@]}" exec -T symphony-e2e curl "$@"
}

cleanup() {
  log "Cleaning up..."
  "${COMPOSE[@]}" exec -T symphony-e2e sh -lc '
    if [ -d /e2e/evidence ]; then
      find /e2e/evidence -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    fi
  ' 2>/dev/null || true
  "${COMPOSE[@]}" down --volumes --remove-orphans --timeout 5 2>/dev/null || true
  remove_e2e_compose_image
  echo "[]" > e2e/fixtures/issues.json 2>/dev/null || true
}
# ── Setup ─────────────────────────────────────────────────────

log "Scenario: ${SCENARIO} (timeout: ${TIMEOUT}s)"
log "Compose project: ${COMPOSE_PROJECT_NAME}"

assert_e2e_project_is_available docker-compose.e2e.yml

echo "[]" > e2e/fixtures/issues.json
trap cleanup EXIT

# Set scenario in environment
export STUB_SCENARIO="$SCENARIO"
STUB_SCENARIO="$SCENARIO" "${COMPOSE[@]}" up -d --build 2>&1 | tail -1

log "Waiting for dashboard state..."
for i in $(seq 1 20); do
  STATUS_JSON=$(orch_curl -sf http://localhost:4680/api/v1/state 2>/dev/null || true)
  HEALTH=$(echo "$STATUS_JSON" | python3 -c "import sys,json; data=json.load(sys.stdin); print(data.get('health',''))" 2>/dev/null || true)
  if [ -n "$HEALTH" ]; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    fail "Dashboard state did not become ready after 20s"
    "${COMPOSE[@]}" logs --tail 20 symphony-e2e 2>&1
    exit 1
  fi
  sleep 1
done
log "Dashboard ready"

# ── Verify authentication gate ────────────────────────────────

UNAUTHENTICATED_STATE_STATUS=$(
  unauthenticated_orch_curl -s -o /dev/null -w '%{http_code}' \
    http://localhost:4680/api/v1/state
)
if [ "$UNAUTHENTICATED_STATE_STATUS" != "401" ]; then
  fail "Expected unauthenticated state endpoint to return 401, got: $UNAUTHENTICATED_STATE_STATUS"
  exit 1
fi

UNAUTHENTICATED_REFRESH_STATUS=$(
  unauthenticated_orch_curl -s -o /dev/null -w '%{http_code}' -X POST \
    http://localhost:4680/api/v1/refresh
)
if [ "$UNAUTHENTICATED_REFRESH_STATUS" != "401" ]; then
  fail "Expected unauthenticated refresh endpoint to return 401, got: $UNAUTHENTICATED_REFRESH_STATUS"
  exit 1
fi
log "Unauthenticated state and refresh requests rejected (401)"

# ── Verify idle ───────────────────────────────────────────────

HEALTH=$(orch_curl -s http://localhost:4680/api/v1/state | python3 -c "import sys,json;print(json.load(sys.stdin)['health'])")
if [ "$HEALTH" != "idle" ]; then
  fail "Expected idle, got: $HEALTH"
  exit 1
fi
log "Initial state: idle"

# ── Inject issues ─────────────────────────────────────────────

if [ "$SCENARIO" = "non-dispatchable" ]; then
  cp e2e/fixtures/non-dispatchable.json e2e/fixtures/issues.json
else
  cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
fi

INITIAL_LAST_TICK=$(orch_curl -s http://localhost:4680/api/v1/state | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastTickAt', ''))")

REFRESH_RESPONSE=$(
  orch_curl -sS -X POST -w '\n__CURL_STATUS__:%{http_code}' \
    http://localhost:4680/api/v1/refresh
)
REFRESH_STATUS=$(printf '%s\n' "$REFRESH_RESPONSE" | awk -F: '/^__CURL_STATUS__/ {print $2}' | tail -1)
REFRESH_BODY=$(printf '%s\n' "$REFRESH_RESPONSE" | sed '/^__CURL_STATUS__/d')

if [ "$REFRESH_STATUS" != "202" ]; then
  fail "Expected refresh endpoint to return 202, got: $REFRESH_STATUS"
  printf '%s\n' "$REFRESH_BODY"
  exit 1
fi

log "Issues injected; refresh trigger accepted (202). Falling back to polling until dispatch is observed"

if [ "$SCENARIO" = "non-dispatchable" ]; then
  for i in $(seq 1 "$TIMEOUT"); do
    STATUS_JSON=$(orch_curl -s http://localhost:4680/api/v1/state)
    LAST_TICK=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastTickAt', ''))")
    if [ -n "$LAST_TICK" ] && [ "$LAST_TICK" != "$INITIAL_LAST_TICK" ]; then
      break
    fi
    if [ "$i" = "$TIMEOUT" ]; then
      fail "Refresh reconciliation did not complete before timeout"
      exit 1
    fi
    sleep 1
  done
  ACTIVE=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['summary']['activeRuns'])")
  if [ "$ACTIVE" != "0" ]; then
    fail "Non-dispatchable issue started a worker"
    exit 1
  fi
  EXPLAIN_JSON=$("${COMPOSE[@]}" exec -T -w /e2e/work/test-repo -e GITHUB_GRAPHQL_TOKEN=e2e-token symphony-e2e \
    node /app/packages/cli/dist/index.js repo explain test-owner/test-repo#1 --json)
  echo "$EXPLAIN_JSON" | python3 -c '
import json
import sys

report = json.load(sys.stdin)
assert report["dispatchable"] is False, report
assert report["summary"] == "Not dispatchable: fixture eligibility gate: assigned to another agent", report
checks = {check["id"]: check for check in report["checks"]}
assert checks["tracker_dispatchability"]["status"] == "block", checks
assert checks["tracker_dispatchability"]["details"]["dispatchReason"] == "fixture eligibility gate: assigned to another agent", checks
'
  if "${COMPOSE[@]}" exec -T symphony-e2e sh -c 'find /e2e/work -name events.ndjson -exec grep -H "run-dispatched" {} + 2>/dev/null | grep -q .'; then
    fail "Non-dispatchable issue wrote a run-dispatched event"
    exit 1
  fi
  log "=== Result ==="
  log "  Worker dispatched: NO"
  log "  Explain reason:    fixture eligibility gate: assigned to another agent"
  echo ""
  log "PASSED"
  exit 0
fi

# ── Poll for dispatch ─────────────────────────────────────────

SAW_RUNNING=false
SAW_RETRY=false
SAW_REDACTED_STATE=false
SCENARIO_RUN_ID=""
ELAPSED=0

log "Polling..."
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))

  STATUS_JSON=$(orch_curl -s http://localhost:4680/api/v1/state 2>/dev/null || echo '{}')
  HEALTH=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('health','?'))" 2>/dev/null || echo "?")
  ACTIVE=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['summary']['activeRuns'])" 2>/dev/null || echo "?")
  RUN_STATUS=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['activeRuns'];print(r[0]['status'] if r else '-')" 2>/dev/null || echo "?")
  PHASE=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['activeRuns'];print(r[0].get('executionPhase','?') if r else '-')" 2>/dev/null || echo "?")
  RETRY_KIND=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);q=d.get('retryQueue',[]);print(q[0]['retryKind'] if q else '-')" 2>/dev/null || echo "-")

  echo "  t+${ELAPSED}s: health=$HEALTH runs=$ACTIVE status=$RUN_STATUS phase=$PHASE retry=$RETRY_KIND"

  if [ "$RUN_STATUS" = "running" ]; then
    SAW_RUNNING=true
    if [ -z "$SCENARIO_RUN_ID" ]; then
      SCENARIO_RUN_ID=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['activeRuns'];print(r[0].get('runId','') if r else '')" 2>/dev/null || echo "")
    fi
    if echo "$STATUS_JSON" | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert any(
    run.get("issueIdentifier") == "test-owner/test-repo#1"
    and run.get("runId") not in (None, "[REDACTED]")
    and "workingDirectory" not in run
    and "workspaceRuntimeDir" not in run
    and run.get("tokenUsage") == "[REDACTED]"
    and (run.get("runtimeSession") or {}).get("sessionId") == "[REDACTED]"
    for run in data.get("activeRuns", [])
)
' 2>/dev/null; then
      SAW_REDACTED_STATE=true
    fi
  fi

  if [ "$RUN_STATUS" = "retrying" ]; then
    SAW_RETRY=true
    # Worker completed and orchestrator saw the exit — remove issues to stop retry loop
    if [ "$SCENARIO" != "transition-race" ] && [ "$SCENARIO" != "api-progress" ] && [ "$SCENARIO" != "api-progress-unknown" ] && [ "$SCENARIO" != "prompt-phase" ] && [ "$SCENARIO" != "retry-attempt" ]; then
      echo "[]" > e2e/fixtures/issues.json
    fi
  fi

  # Check terminal conditions based on scenario
  if [ "$HEALTH" = "idle" ] && [ "$ACTIVE" = "0" ] && [ "$SAW_RUNNING" = true ]; then
    break
  fi
done

# ── Results ───────────────────────────────────────────────────

echo ""
log "=== Worker Logs ==="
"${COMPOSE[@]}" exec -T symphony-e2e sh -c 'for f in $(find /e2e/work -name worker.log 2>/dev/null | sort | tail -1); do cat "$f"; done' 2>/dev/null || true

echo ""
log "=== Event Logs ==="
"${COMPOSE[@]}" exec -T symphony-e2e sh -c 'find /e2e/work -name events.ndjson -exec cat {} \; 2>/dev/null' 2>/dev/null || true

echo ""
if [ "$SCENARIO" = "transition-race" ]; then
  if [ "$SAW_RUNNING" != true ]; then
    fail "=== Result ==="
    fail "  Worker reached running:    $SAW_RUNNING"
    fail "FAILED"
    "${COMPOSE[@]}" logs --tail 20 symphony-e2e 2>&1
    exit 1
  fi
  python3 - <<'PY'
import json
from pathlib import Path

issues = json.loads(Path("e2e/fixtures/issues.json").read_text())
assert len(issues) == 1, issues
issue = issues[0]
assert issue["state"] == "In review", issue
comments = issue.get("metadata", {}).get("transitionComments", [])
expected = "🔁 Status: `Ready` → `In review`\n\nReason: E2E transition comment race\nCycle: e2e transition-race"
assert comments == [expected], comments
PY
  log "Confirmed transition comment survived worker reconciliation: YES"
  log "=== Result ==="
  log "  Worker dispatched and ran: YES"
  log "  Final tracker state:      In review"
  log "  Exact comments:           1"
  log "  Elapsed:                  ${ELAPSED}s"
  echo ""
  log "PASSED"
  exit 0
fi

if [ "$SCENARIO" = "api-progress" ] || [ "$SCENARIO" = "prompt-phase" ] || [ "$SCENARIO" = "retry-attempt" ]; then
  if [ "$SAW_RUNNING" != true ]; then
    fail "Worker did not reach running state"
    exit 1
  fi
  python3 - <<'PY'
import json
from pathlib import Path

issues = json.loads(Path("e2e/fixtures/issues.json").read_text())
assert len(issues) == 1, issues
assert issues[0]["state"] == "Done", issues[0]
PY
  if [ -z "$SCENARIO_RUN_ID" ] || [ "$SCENARIO_RUN_ID" = "[REDACTED]" ]; then
    fail "Scenario run id was not captured"
    exit 1
  fi
  "${COMPOSE[@]}" exec -T -e SCENARIO_RUN_ID="$SCENARIO_RUN_ID" -e SCENARIO="$SCENARIO" symphony-e2e node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const allScenarioRuns = execFileSync("find", [
      "/e2e/work",
      "-path",
      "*/runs/*/run.json",
    ], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (process.env.SCENARIO === "retry-attempt") {
      if (allScenarioRuns.length !== 2) {
        throw new Error(`expected_initial_and_retry_runs:${JSON.stringify(allScenarioRuns)}`);
      }
      const retries = allScenarioRuns
        .map((path) => JSON.parse(readFileSync(path, "utf8")))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      if (
        retries[0]?.runPhase !== "succeeded" ||
        retries[1]?.status !== "succeeded" ||
        retries[1]?.runPhase !== "succeeded"
      ) {
        throw new Error(`retry_attempt_run_not_succeeded:${JSON.stringify(retries)}`);
      }
      process.exit(0);
    }
    const paths = execFileSync("find", [
      "/e2e/work",
      "-path",
      `*/runs/${process.env.SCENARIO_RUN_ID}/run.json`,
    ], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (paths.length !== 1) throw new Error(`expected_one_scenario_run:${JSON.stringify(paths)}`);
    if (allScenarioRuns.length !== 1) {
      throw new Error(`unexpected_replacement_runs:${JSON.stringify(allScenarioRuns)}`);
    }
    const run = JSON.parse(readFileSync(paths[0], "utf8"));
    if (run.runId !== process.env.SCENARIO_RUN_ID) {
      throw new Error(`unexpected_run_id:${run.runId}`);
    }
    if (run.status !== "succeeded" || run.runPhase !== "succeeded") {
      throw new Error(`unexpected_run_outcome:${JSON.stringify({status: run.status, runPhase: run.runPhase})}`);
    }
  '
  if ! "${COMPOSE[@]}" logs symphony-e2e 2>&1 | grep -q 'api-progress readback.*"state":"Done"'; then
    fail "Confirmed Done readback was not observed"
    exit 1
  fi
  if [ "$SCENARIO" = "prompt-phase" ] && ! "${COMPOSE[@]}" exec -T symphony-e2e sh -c 'grep -R -q "scenario=prompt-phase" /e2e/work'; then
    fail "Stub worker did not start under the prompt-phase scenario"
    exit 1
  fi
  log "=== Result ==="
  log "  Canonical tracker state: Done"
  log "  Persisted run outcome:   succeeded/succeeded"
  log "  Reconciliation override: NO"
  echo ""
  log "PASSED"
  exit 0
fi

if [ "$SCENARIO" = "api-progress-unknown" ]; then
  if [ "$SAW_RUNNING" != true ]; then
    fail "Worker did not reach running state"
    exit 1
  fi
  "${COMPOSE[@]}" exec -T -e SCENARIO_RUN_ID="$SCENARIO_RUN_ID" symphony-e2e node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const eventPaths = execFileSync("find", ["/e2e/work", "-path", `*/runs/${process.env.SCENARIO_RUN_ID}/events.ndjson`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (eventPaths.length !== 1) throw new Error(`expected_one_event_log:${JSON.stringify(eventPaths)}`);
    const events = readFileSync(eventPaths[0], "utf8").trim().split("\n").map(JSON.parse).filter((event) => event.event === "run-finalization-deferred");
    if (events.length !== 3) throw new Error(`expected_three_deferrals:${JSON.stringify(events)}`);
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].consecutiveDeferrals !== index + 1 || events[index].maxDeferrals !== 3 || events[index].exhausted !== (index === 2)) {
        throw new Error(`unexpected_deferral_sequence:${JSON.stringify(events)}`);
      }
    }
  '
  log "=== Result ==="
  log "  Canonical tracker readback: unknown after confirmed progress"
  log "  Persisted deferrals:        3 (bounded)"
  log "  Final deferral exhausted:   YES"
  echo ""
  log "PASSED"
  exit 0
fi

CONFIGURED_WORKSPACE_ROOT=false
if "${COMPOSE[@]}" exec -T symphony-e2e node --input-type=module -e '
  import { existsSync, readFileSync } from "node:fs";
  import { dirname, resolve, sep } from "node:path";
  import { execFileSync } from "node:child_process";
  const repoDir = "/e2e/work/test-repo";
  const stateDir = `${repoDir}/.runtime/orchestrator/projects/repository`;
  const expectedRoot = `${repoDir}/.runtime/symphony-workspaces`;
  const project = JSON.parse(readFileSync(`${stateDir}/project.json`, "utf8"));
  if (project.repositoryDir !== repoDir || project.workspaceDir !== expectedRoot) {
    throw new Error(`unexpected_project_paths:${JSON.stringify(project)}`);
  }
  const records = execFileSync("find", [stateDir, "-name", "workspace.json"], {
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  if (records.length !== 1) throw new Error(`expected_one_workspace_record:${JSON.stringify(records)}`);
  const record = JSON.parse(readFileSync(records[0], "utf8"));
  const workspacePath = resolve(record.workspacePath);
  if (!workspacePath.startsWith(`${resolve(expectedRoot)}${sep}`)) {
    throw new Error(`workspace_outside_configured_root:${workspacePath}`);
  }
  if (existsSync(`${dirname(records[0])}/repository`)) {
    throw new Error(`workspace_populated_beside_state:${dirname(records[0])}`);
  }
'; then
  CONFIGURED_WORKSPACE_ROOT=true
  log "Configured repo-embedded workspace root: YES"
fi

if [ "$SAW_RUNNING" = true ] && [ "$SAW_REDACTED_STATE" = true ] && [ "$CONFIGURED_WORKSPACE_ROOT" = true ]; then
  log "=== Result ==="
  log "  Worker dispatched and ran: YES"
  log "  Routable IDs + redaction:  YES"
  log "  Configured workspace root: YES"
  log "  Worker entered retry:     $SAW_RETRY"
  log "  Final health:             $HEALTH"
  log "  Elapsed:                  ${ELAPSED}s"
  echo ""
  log "PASSED"
  exit 0
else
  fail "=== Result ==="
  fail "  Worker reached running:    $SAW_RUNNING"
  fail "  Routable IDs + redaction:  $SAW_REDACTED_STATE"
  fail "  Configured workspace root: $CONFIGURED_WORKSPACE_ROOT"
  echo ""
  fail "FAILED"
  "${COMPOSE[@]}" logs --tail 20 symphony-e2e 2>&1
  exit 1
fi

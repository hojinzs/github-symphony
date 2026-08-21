#!/usr/bin/env bash
set -euo pipefail

# E2E Test Runner — polls the standalone dashboard until the scenario completes.
# Usage: ./e2e/run-e2e.sh [scenario] [timeout_seconds]
#   scenario: happy (default), fail, stall, slow, transition-race, api-progress
#   timeout:  30 (default)

SCENARIO="${1:-happy}"
TIMEOUT="${2:-30}"
COMPOSE="docker compose -f docker-compose.e2e.yml"
HTTP_API_TOKEN="${GH_SYMPHONY_HTTP_TOKEN:-e2e-http-token}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[e2e]${NC} $*"; }
warn() { echo -e "${YELLOW}[e2e]${NC} $*"; }
fail() { echo -e "${RED}[e2e]${NC} $*"; }
orch_curl() {
  $COMPOSE exec -T symphony-e2e curl \
    -H "Authorization: Bearer ${HTTP_API_TOKEN}" "$@"
}
unauthenticated_orch_curl() {
  $COMPOSE exec -T symphony-e2e curl "$@"
}

cleanup() {
  log "Cleaning up..."
  $COMPOSE exec -T symphony-e2e sh -lc '
    if [ -d /e2e/evidence ]; then
      find /e2e/evidence -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    fi
  ' 2>/dev/null || true
  $COMPOSE down --timeout 5 2>/dev/null || true
  echo "[]" > e2e/fixtures/issues.json 2>/dev/null || true
}
trap cleanup EXIT

# ── Setup ─────────────────────────────────────────────────────

log "Scenario: ${SCENARIO} (timeout: ${TIMEOUT}s)"

echo "[]" > e2e/fixtures/issues.json

# Set scenario in environment
export STUB_SCENARIO="$SCENARIO"
STUB_SCENARIO="$SCENARIO" $COMPOSE up -d --build 2>&1 | tail -1

log "Waiting for dashboard state..."
for i in $(seq 1 20); do
  STATUS_JSON=$(orch_curl -sf http://localhost:4680/api/v1/state 2>/dev/null || true)
  HEALTH=$(echo "$STATUS_JSON" | python3 -c "import sys,json; data=json.load(sys.stdin); print(data.get('health',''))" 2>/dev/null || true)
  if [ -n "$HEALTH" ]; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    fail "Dashboard state did not become ready after 20s"
    docker logs symphony-e2e 2>&1 | tail -20
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

cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json

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
    SCENARIO_RUN_ID=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['activeRuns'];print(r[0].get('runId','') if r else '')" 2>/dev/null || echo "")
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
    if [ "$SCENARIO" != "transition-race" ] && [ "$SCENARIO" != "api-progress" ]; then
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
docker exec symphony-e2e sh -c 'for f in $(find /e2e/work -name worker.log 2>/dev/null | sort | tail -1); do cat "$f"; done' 2>/dev/null || true

echo ""
log "=== Event Logs ==="
docker exec symphony-e2e sh -c 'find /e2e/work -name events.ndjson -exec cat {} \; 2>/dev/null' 2>/dev/null || true

echo ""
if [ "$SCENARIO" = "transition-race" ]; then
  if [ "$SAW_RUNNING" != true ]; then
    fail "=== Result ==="
    fail "  Worker reached running:    $SAW_RUNNING"
    fail "FAILED"
    docker logs symphony-e2e 2>&1 | tail -20
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

if [ "$SCENARIO" = "api-progress" ]; then
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
  docker exec -e SCENARIO_RUN_ID="$SCENARIO_RUN_ID" symphony-e2e node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const paths = execFileSync("find", [
      "/e2e/work",
      "-path",
      `*/runs/${process.env.SCENARIO_RUN_ID}/run.json`,
    ], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (paths.length !== 1) throw new Error(`expected_one_scenario_run:${JSON.stringify(paths)}`);
    const run = JSON.parse(readFileSync(paths[0], "utf8"));
    if (run.runId !== process.env.SCENARIO_RUN_ID) {
      throw new Error(`unexpected_run_id:${run.runId}`);
    }
    if (run.status !== "succeeded" || run.runPhase !== "succeeded") {
      throw new Error(`unexpected_run_outcome:${JSON.stringify({status: run.status, runPhase: run.runPhase})}`);
    }
  '
  if ! docker logs symphony-e2e 2>&1 | grep -q 'api-progress readback.*"state":"Done"'; then
    fail "Confirmed Done readback was not observed"
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

if [ "$SAW_RUNNING" = true ] && [ "$SAW_REDACTED_STATE" = true ]; then
  log "=== Result ==="
  log "  Worker dispatched and ran: YES"
  log "  Routable IDs + redaction:  YES"
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
  echo ""
  fail "FAILED"
  docker logs symphony-e2e 2>&1 | tail -20
  exit 1
fi

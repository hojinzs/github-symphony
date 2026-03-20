#!/usr/bin/env bash
set -euo pipefail

# E2E Test Runner — polls orchestrator status until the scenario completes.
# Usage: ./e2e/run-e2e.sh [scenario] [timeout_seconds]
#   scenario: happy (default), fail, stall, slow
#   timeout:  30 (default)

SCENARIO="${1:-happy}"
TIMEOUT="${2:-30}"
COMPOSE="docker compose -f docker-compose.e2e.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[e2e]${NC} $*"; }
warn() { echo -e "${YELLOW}[e2e]${NC} $*"; }
fail() { echo -e "${RED}[e2e]${NC} $*"; }

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

log "Waiting for healthz..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:4680/healthz >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    fail "Healthcheck failed after 20s"
    docker logs symphony-e2e 2>&1 | tail -20
    exit 1
  fi
  sleep 1
done
log "Orchestrator ready"

# ── Verify idle ───────────────────────────────────────────────

HEALTH=$(curl -s http://localhost:4680/api/v1/status | python3 -c "import sys,json;print(json.load(sys.stdin)['health'])")
if [ "$HEALTH" != "idle" ]; then
  fail "Expected idle, got: $HEALTH"
  exit 1
fi
log "Initial state: idle"

# ── Inject issues ─────────────────────────────────────────────

cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
curl -s -X POST http://localhost:4680/api/v1/refresh >/dev/null
log "Issues injected, refresh triggered"

# ── Poll for dispatch ─────────────────────────────────────────

SAW_RUNNING=false
SAW_RETRY=false
ELAPSED=0

log "Polling..."
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))

  STATUS_JSON=$(curl -s http://localhost:4680/api/v1/status 2>/dev/null || echo '{}')
  HEALTH=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('health','?'))" 2>/dev/null || echo "?")
  ACTIVE=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['summary']['activeRuns'])" 2>/dev/null || echo "?")
  RUN_STATUS=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['activeRuns'];print(r[0]['status'] if r else '-')" 2>/dev/null || echo "?")
  PHASE=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['activeRuns'];print(r[0].get('executionPhase','?') if r else '-')" 2>/dev/null || echo "?")
  RETRY_KIND=$(echo "$STATUS_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);q=d.get('retryQueue',[]);print(q[0]['retryKind'] if q else '-')" 2>/dev/null || echo "-")

  echo "  t+${ELAPSED}s: health=$HEALTH runs=$ACTIVE status=$RUN_STATUS phase=$PHASE retry=$RETRY_KIND"

  if [ "$RUN_STATUS" = "running" ]; then
    SAW_RUNNING=true
  fi

  if [ "$RUN_STATUS" = "retrying" ]; then
    SAW_RETRY=true
    # Worker completed and orchestrator saw the exit — remove issues to stop retry loop
    echo "[]" > e2e/fixtures/issues.json
  fi

  # Check terminal conditions based on scenario
  if [ "$HEALTH" = "idle" ] && [ "$ACTIVE" = "0" ] && [ "$SAW_RUNNING" = true ]; then
    break
  fi
done

# ── Results ───────────────────────────────────────────────────

echo ""
log "=== Worker Logs ==="
docker exec symphony-e2e sh -c 'for f in $(find /app/.runtime/projects/e2e-project/runs -name worker.log 2>/dev/null | sort | tail -1); do cat "$f"; done' 2>/dev/null || true

echo ""
log "=== Event Logs ==="
docker exec symphony-e2e sh -c 'find /app/.runtime/projects/e2e-project/runs -name events.ndjson -exec cat {} \; 2>/dev/null' 2>/dev/null || true

echo ""
if [ "$SAW_RUNNING" = true ]; then
  log "=== Result ==="
  log "  Worker dispatched and ran: YES"
  log "  Worker entered retry:     $SAW_RETRY"
  log "  Final health:             $HEALTH"
  log "  Elapsed:                  ${ELAPSED}s"
  echo ""
  log "PASSED"
  exit 0
else
  fail "=== Result ==="
  fail "  Worker never reached 'running' state within ${TIMEOUT}s"
  echo ""
  fail "FAILED"
  docker logs symphony-e2e 2>&1 | tail -20
  exit 1
fi

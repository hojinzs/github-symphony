#!/usr/bin/env bash
set -euo pipefail

# E2E Test: PR Review Lifecycle
# Tests phase transitions: planning → (continuation retry) → implementation
#
# Flow:
#   1. Inject issue with state "Ready" → stub worker reports executionPhase="planning"
#   2. Worker exits → orchestrator schedules continuation retry
#   3. Switch issue state to "In Progress" → stub worker reports executionPhase="implementation"
#   4. Worker exits → orchestrator schedules continuation retry
#   5. Remove issue → retry fails → run released

TIMEOUT="${1:-60}"
COMPOSE="docker compose -f docker-compose.e2e.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[e2e:pr-review]${NC} $*"; }
warn() { echo -e "${YELLOW}[e2e:pr-review]${NC} $*"; }
fail() { echo -e "${RED}[e2e:pr-review]${NC} $*"; }

cleanup() {
  log "Cleaning up..."
  $COMPOSE down --timeout 5 2>/dev/null || true
  echo "[]" > e2e/fixtures/issues.json 2>/dev/null || true
}
trap cleanup EXIT

# ── Setup ─────────────────────────────────────────────────────

log "PR Review lifecycle test (timeout: ${TIMEOUT}s)"

echo "[]" > e2e/fixtures/issues.json

export STUB_SCENARIO="pr-review"
STUB_SCENARIO="pr-review" $COMPOSE up -d --build 2>&1 | tail -1

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

# ── Phase 1: Planning ────────────────────────────────────────

log "Phase 1: Injecting issue with state=Ready (planning phase)"
cp e2e/fixtures/pr-review.json e2e/fixtures/issues.json
curl -s -X POST http://localhost:4680/api/v1/refresh >/dev/null

SAW_PLANNING=false
SAW_IMPLEMENTATION=false
SAW_RETRY=false
SWITCHED_TO_IN_PROGRESS=false
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

  # Track observed phases
  if [ "$PHASE" = "planning" ]; then
    SAW_PLANNING=true
  fi
  if [ "$PHASE" = "implementation" ]; then
    SAW_IMPLEMENTATION=true
  fi

  # Phase 2: After seeing planning and a retry, switch issue to "In Progress"
  if [ "$SAW_PLANNING" = true ] && [ "$SWITCHED_TO_IN_PROGRESS" = false ] && [ "$RUN_STATUS" = "retrying" ]; then
    log "Phase 2: Switching issue state to 'In Progress' (implementation phase)"
    cp e2e/fixtures/pr-review-in-progress.json e2e/fixtures/issues.json
    SWITCHED_TO_IN_PROGRESS=true
  fi

  # Phase 3: After seeing implementation and retry, remove issue to stop loop
  if [ "$SAW_IMPLEMENTATION" = true ] && [ "$RUN_STATUS" = "retrying" ] && [ "$SWITCHED_TO_IN_PROGRESS" = true ]; then
    if [ "$SAW_RETRY" = false ]; then
      SAW_RETRY=true
      log "Phase 3: Removing issue to end retry loop"
      echo "[]" > e2e/fixtures/issues.json
    fi
  fi

  # Terminal: idle with no active runs after having seen both phases
  if [ "$HEALTH" = "idle" ] && [ "$ACTIVE" = "0" ] && [ "$SAW_PLANNING" = true ] && [ "$SAW_IMPLEMENTATION" = true ]; then
    break
  fi
done

# ── Results ───────────────────────────────────────────────────

echo ""
log "=== Worker Logs ==="
docker exec symphony-e2e sh -c 'for f in $(find /app/.runtime/projects/e2e-project/runs -name worker.log 2>/dev/null | sort); do echo "--- $f ---"; cat "$f"; done' 2>/dev/null || true

echo ""
log "=== Event Logs ==="
docker exec symphony-e2e sh -c 'find /app/.runtime/projects/e2e-project/runs -name events.ndjson -exec cat {} \; 2>/dev/null' 2>/dev/null || true

echo ""
log "=== Result ==="
PASSED=true

if [ "$SAW_PLANNING" = true ]; then
  log "  Saw planning phase:        YES"
else
  fail "  Saw planning phase:        NO"
  PASSED=false
fi

if [ "$SAW_IMPLEMENTATION" = true ]; then
  log "  Saw implementation phase:  YES"
else
  fail "  Saw implementation phase:  NO"
  PASSED=false
fi

if [ "$SWITCHED_TO_IN_PROGRESS" = true ]; then
  log "  Phase transition triggered: YES"
else
  fail "  Phase transition triggered: NO"
  PASSED=false
fi

log "  Final health:              $HEALTH"
log "  Elapsed:                   ${ELAPSED}s"
echo ""

if [ "$PASSED" = true ]; then
  log "PASSED"
  exit 0
else
  fail "FAILED"
  docker logs symphony-e2e 2>&1 | tail -30
  exit 1
fi

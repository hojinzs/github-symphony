#!/usr/bin/env bash
set -euo pipefail

# E2E Test Runner — polls the standalone dashboard until the scenario completes.
# Usage: ./e2e/run-e2e.sh [scenario] [timeout_seconds]
#   scenario: happy (default), fail, stall, slow, transition-race, api-progress, api-progress-unknown, prompt-phase, retry-attempt, recovery-fail, non-dispatchable, required-label-missing, required-label-removed, linear-dirty-recovery, dirty-unpublished-worktree
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
write_empty_issues() {
  local fixture_copy
  fixture_copy=$(mktemp e2e/fixtures/issues.json.tmp.XXXXXX)
  printf '[]\n' > "$fixture_copy"
  mv "$fixture_copy" e2e/fixtures/issues.json
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
  write_empty_issues 2>/dev/null || true
  rm -f e2e/fixtures/required-label-removed.signal
}
# ── Setup ─────────────────────────────────────────────────────

log "Scenario: ${SCENARIO} (timeout: ${TIMEOUT}s)"
log "Compose project: ${COMPOSE_PROJECT_NAME}"

assert_e2e_project_is_available docker-compose.e2e.yml

write_empty_issues
rm -f e2e/fixtures/required-label-removed.signal
trap cleanup EXIT

# Set scenario in environment
export STUB_SCENARIO="$SCENARIO"
E2E_REQUIRED_LABELS=""
E2E_MAX_FAILURE_RETRIES=""
if [ "$SCENARIO" = "required-label-missing" ] || [ "$SCENARIO" = "required-label-removed" ]; then
  E2E_REQUIRED_LABELS="agent"
fi
if [ "$SCENARIO" = "recovery-fail" ]; then
  E2E_MAX_FAILURE_RETRIES="3"
fi
E2E_REQUIRED_LABELS="$E2E_REQUIRED_LABELS" E2E_MAX_FAILURE_RETRIES="$E2E_MAX_FAILURE_RETRIES" STUB_SCENARIO="$SCENARIO" "${COMPOSE[@]}" up -d --build 2>&1 | tail -1

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
elif [ "$SCENARIO" = "linear-dirty-recovery" ]; then
  cp e2e/fixtures/linear-dirty-recovery.json e2e/fixtures/issues.json
elif [ "$SCENARIO" = "required-label-missing" ]; then
  cp e2e/fixtures/required-label-missing.json e2e/fixtures/issues.json
elif [ "$SCENARIO" = "required-label-removed" ]; then
  cp e2e/fixtures/required-label-active.json e2e/fixtures/issues.json
elif [ "$SCENARIO" = "dirty-unpublished-worktree" ]; then
  DIRTY_FIXTURE_B64=$(base64 < e2e/fixtures/happy-path.json | tr -d '\n')
  "${COMPOSE[@]}" exec -T -e "FIXTURE_B64=$DIRTY_FIXTURE_B64" symphony-e2e \
    node --input-type=module -e '
      import { writeFileSync } from "node:fs";
      writeFileSync(
        "/e2e/fixtures/issues.json",
        Buffer.from(process.env.FIXTURE_B64, "base64")
      );
    '
else
  cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
fi

INITIAL_LAST_TICK=$(orch_curl -s http://localhost:4680/api/v1/state 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastTickAt') or '')" 2>/dev/null || echo '')

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

log "Issues injected; refresh trigger accepted (202). Polling for reconciliation"

if [ "$SCENARIO" = "non-dispatchable" ] || [ "$SCENARIO" = "required-label-missing" ]; then
  # A tick can have started before the fixture copy, then publish after the
  # refresh request. Waiting for two new tick start timestamps means the
  # second observed tick must have started after that older tick finished.
  # It therefore cannot have read the pre-injection fixture.
  PREVIOUS_LAST_TICK="$INITIAL_LAST_TICK"
  TICKS_SEEN=0
  for i in $(seq 1 "$TIMEOUT"); do
    STATUS_JSON=$(orch_curl -s http://localhost:4680/api/v1/state 2>/dev/null || echo '{}')
    LAST_TICK=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastTickAt') or '')" 2>/dev/null || echo '')
    if [ -n "$LAST_TICK" ] && [ "$LAST_TICK" != "$PREVIOUS_LAST_TICK" ]; then
      PREVIOUS_LAST_TICK="$LAST_TICK"
      TICKS_SEEN=$((TICKS_SEEN + 1))
      if [ "$TICKS_SEEN" -ge 2 ]; then
        break
      fi
    fi
    if [ "$i" = "$TIMEOUT" ]; then
      fail "Two post-injection reconciliation ticks did not complete before timeout"
      exit 1
    fi
    sleep 1
  done
  ACTIVE=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['summary']['activeRuns'])" 2>/dev/null || echo '?')
  if [ "$ACTIVE" != "0" ]; then
    fail "Ineligible issue started a worker"
    exit 1
  fi
  EXPLAIN_JSON=$("${COMPOSE[@]}" exec -T -w /e2e/work/test-repo -e GITHUB_GRAPHQL_TOKEN=e2e-token symphony-e2e \
    node /app/packages/cli/dist/index.js repo explain test-owner/test-repo#1 --json)
  if [ "$SCENARIO" = "required-label-missing" ]; then
    echo "$EXPLAIN_JSON" | python3 -c '
import json
import sys

report = json.load(sys.stdin)
assert report["dispatchable"] is False, report
assert report["summary"] == "Not dispatchable: not routable: Issue is missing required labels (\"agent\").", report
checks = {check["id"]: check for check in report["checks"]}
assert checks["workflow_routability"]["status"] == "block", checks
'
  else
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
  fi
  if "${COMPOSE[@]}" exec -T symphony-e2e sh -c 'find /e2e/work -name events.ndjson -exec grep -H "run-dispatched" {} + 2>/dev/null | grep -q .'; then
    fail "Non-dispatchable issue wrote a run-dispatched event"
    exit 1
  fi
  log "=== Result ==="
  log "  Worker dispatched: NO"
  log "  Explain reason:    $( [ "$SCENARIO" = "required-label-missing" ] && echo 'missing required label' || echo 'fixture eligibility gate' )"
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
LABEL_REMOVED=false
LINEAR_RECOVERY_REACTIVATED=false

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
    if [ "$SCENARIO" = "required-label-removed" ] && [ "$LABEL_REMOVED" != true ]; then
      python3 - <<'PY'
import json
from pathlib import Path
path = Path("e2e/fixtures/issues.json")
issues = json.loads(path.read_text())
issues[0]["labels"] = []
path.write_text(json.dumps(issues))
PY
      : > e2e/fixtures/required-label-removed.signal
      LABEL_REMOVED=true
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
    if [ "$SCENARIO" != "transition-race" ] && [ "$SCENARIO" != "api-progress" ] && [ "$SCENARIO" != "api-progress-unknown" ] && [ "$SCENARIO" != "prompt-phase" ] && [ "$SCENARIO" != "retry-attempt" ] && [ "$SCENARIO" != "recovery-fail" ] && [ "$SCENARIO" != "linear-dirty-recovery" ]; then
      write_empty_issues
    fi
  fi

  if [ "$SCENARIO" = "linear-dirty-recovery" ] && [ "$LINEAR_RECOVERY_REACTIVATED" != true ]; then
    if "${COMPOSE[@]}" exec -T symphony-e2e sh -c 'grep -R -q "incomplete-turn-dirty-workspace" /e2e/work 2>/dev/null'; then
      python3 - <<'PY'
import json
from pathlib import Path

path = Path("e2e/fixtures/issues.json")
issues = json.loads(path.read_text())
assert len(issues) == 1, issues
issues[0]["state"] = "Ready"
path.write_text(json.dumps(issues))
PY
      orch_curl -sf -X POST http://localhost:4680/api/v1/refresh >/dev/null
      LINEAR_RECOVERY_REACTIVATED=true
      log "Linear dirty recovery reactivated after incomplete-turn classification"
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
if [ "$SCENARIO" = "linear-dirty-recovery" ]; then
  if [ "$SAW_RUNNING" != true ] || [ "$LINEAR_RECOVERY_REACTIVATED" != true ]; then
    fail "Linear dirty recovery did not complete its initial and recovery dispatches"
    exit 1
  fi
  if ! "${COMPOSE[@]}" exec -T symphony-e2e sh -c 'grep -R -q "linear dirty recovery verified" /e2e/work'; then
    fail "Recovery worker did not verify the preserved Linear workspace"
    exit 1
  fi
  if "${COMPOSE[@]}" exec -T symphony-e2e sh -c 'find /e2e/work -name events.ndjson -exec grep -H "recovery-quarantined" {} + 2>/dev/null | grep -q .'; then
    fail "Linear dirty workspace was quarantined"
    exit 1
  fi
  python3 - <<'PY'
import json
from pathlib import Path

issues = json.loads(Path("e2e/fixtures/issues.json").read_text())
assert len(issues) == 1, issues
assert issues[0]["identifier"] == "DEV-54", issues[0]
assert issues[0]["state"] == "Done", issues[0]
PY
  log "=== Result ==="
  log "  Linear dirty workspace classified: YES"
  log "  Recovery dispatch reactivated:     YES"
  log "  Branch and workpad preserved:      YES"
  log "  Quarantine event emitted:          NO"
  log "PASSED"
  exit 0
fi

echo ""
if [ "$SCENARIO" = "required-label-removed" ]; then
  if [ "$SAW_RUNNING" != true ] || [ "$LABEL_REMOVED" != true ]; then
    fail "Required-label removal did not reach an active worker"
    exit 1
  fi
  if ! "${COMPOSE[@]}" exec -T symphony-e2e sh -c 'grep -R -q "turn=1 completed" /e2e/work && grep -R -q "turn=2 prevented by routability refresh" /e2e/work'; then
    fail "Expected the routability refresh to prevent turn two after label removal"
    exit 1
  fi
  log "=== Result ==="
  log "  Worker started with required label: YES"
  log "  Label removed during run:          YES"
  log "  Turn one completed:                YES"
  log "  Turn two prevented by refresh:     YES"
  log "PASSED"
  exit 0
fi

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

if [ "$SCENARIO" = "recovery-fail" ]; then
  if [ "$SAW_RUNNING" != true ] || [ "$SAW_RETRY" != true ]; then
    fail "Recovery circuit-breaker scenario did not observe running and retrying states"
    exit 1
  fi
  "${COMPOSE[@]}" exec -T symphony-e2e node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const stateDir = "/e2e/work/test-repo/.runtime/orchestrator/projects/repository";
    const issues = JSON.parse(readFileSync(`${stateDir}/issues.json`, "utf8"));
    const issue = issues.find((candidate) => candidate.issueId === "issue-happy-1");
    if (!issue || issue.state !== "released" || issue.failureRetryCount !== 3 || issue.retryEntry !== null) {
      throw new Error(`unexpected_issue_circuit_breaker:${JSON.stringify(issue)}`);
    }
    const paths = execFileSync("find", [stateDir, "-path", "*/runs/*/run.json"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const runs = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
    const suppressed = runs.find((run) => run.status === "suppressed");
    if (runs.length !== 3 || !suppressed) {
      throw new Error(`unexpected_recovery_run_count:${JSON.stringify(runs.map((run) => ({runId: run.runId, status: run.status})))}`);
    }
    if (!suppressed.lastError?.includes("Manual intervention required") || !suppressed.recovery?.dirtyFiles?.includes("recovery-loop.txt")) {
      throw new Error(`missing_manual_recovery_context:${JSON.stringify(suppressed)}`);
    }
  '
  RUN_COUNT_BEFORE=$("${COMPOSE[@]}" exec -T symphony-e2e sh -c 'find /e2e/work/test-repo/.runtime/orchestrator/projects/repository -path "*/runs/*/run.json" | wc -l | tr -d " "')
  orch_curl -sf -X POST http://localhost:4680/api/v1/refresh >/dev/null
  sleep 2
  orch_curl -sf -X POST http://localhost:4680/api/v1/refresh >/dev/null
  sleep 2
  RUN_COUNT_AFTER=$("${COMPOSE[@]}" exec -T symphony-e2e sh -c 'find /e2e/work/test-repo/.runtime/orchestrator/projects/repository -path "*/runs/*/run.json" | wc -l | tr -d " "')
  if [ "$RUN_COUNT_AFTER" != "$RUN_COUNT_BEFORE" ]; then
    fail "Suppressed recovery issue redispatched after later refreshes"
    exit 1
  fi
  log "=== Result ==="
  log "  Dirty recovery failures:    3"
  log "  Final outcome:              suppressed/manual intervention"
  log "  Claim released:             YES"
  log "  Later refresh redispatch:   NO"
  echo ""
  log "PASSED"
  exit 0
fi

if [ "$SCENARIO" = "dirty-unpublished-worktree" ]; then
  if [ "$SAW_RUNNING" != true ]; then
    fail "Dirty unpublished worktree scenario did not reach a running worker"
    exit 1
  fi
  "${COMPOSE[@]}" exec -T symphony-e2e node --input-type=module -e '
    import { existsSync, readFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const stateDir = "/e2e/work/test-repo/.runtime/orchestrator/projects/repository";
    const workspacePaths = execFileSync("find", [stateDir, "-name", "workspace.json"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (workspacePaths.length !== 1) throw new Error(`expected_one_workspace:${JSON.stringify(workspacePaths)}`);
    const workspace = JSON.parse(readFileSync(workspacePaths[0], "utf8"));
    if (workspace.status !== "active" || !workspace.lastError?.startsWith("git_unpublished_worktree: committed_transport_succeeded")) {
      throw new Error(`unexpected_workspace_retention:${JSON.stringify(workspace)}`);
    }
    if (!existsSync(`${workspace.repositoryPath}/tracked.txt`) || !existsSync(`${workspace.repositoryPath}/untracked/notes.txt`)) {
      throw new Error(`unpublished_files_removed:${workspace.repositoryPath}`);
    }
    const runPaths = execFileSync("find", [stateDir, "-path", "*/runs/*/run.json"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (runPaths.length !== 1) throw new Error(`expected_one_run:${JSON.stringify(runPaths)}`);
    const run = JSON.parse(readFileSync(runPaths[0], "utf8"));
    if (run.status !== "succeeded" || run.runPhase !== "succeeded" || !run.lastError?.startsWith("git_unpublished_worktree: committed_transport_succeeded")) {
      throw new Error(`unexpected_dirty_publication_run:${JSON.stringify(run)}`);
    }
  '
  log "=== Result ==="
  log "  Committed transport outcome: succeeded"
  log "  Unpublished tracked/untracked work: retained"
  log "  Terminal workspace cleanup: deferred"
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

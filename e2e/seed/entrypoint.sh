#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/e2e/repos/test-owner/test-repo"
WORK_DIR="/e2e/work/test-repo"

# Ensure the tmpfs-backed work root exists.
mkdir -p /e2e/work
rm -rf "$WORK_DIR"
git clone "$REPO_DIR" "$WORK_DIR"
git -C "$WORK_DIR" remote set-url origin test-owner/test-repo

if [ -n "${E2E_REQUIRED_LABELS:-}" ]; then
  awk -v labels="$E2E_REQUIRED_LABELS" '
    /^  active_states:/ {
      print "  required_labels:"
      count = split(labels, values, ",")
      for (labelIndex = 1; labelIndex <= count; labelIndex += 1) print "    - " values[labelIndex]
    }
    { print }
  ' "$WORK_DIR/WORKFLOW.md" > /tmp/e2e-workflow.md
  mv /tmp/e2e-workflow.md "$WORK_DIR/WORKFLOW.md"
fi

if [ -n "${E2E_MAX_FAILURE_RETRIES:-}" ]; then
  awk -v retries="$E2E_MAX_FAILURE_RETRIES" '
    /^  max_concurrent_agents:/ {
      print
      print "  max_failure_retries: " retries
      next
    }
    { print }
  ' "$WORK_DIR/WORKFLOW.md" > /tmp/e2e-workflow.md
  mv /tmp/e2e-workflow.md "$WORK_DIR/WORKFLOW.md"
fi

# GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH is intentionally limited to the
# file-tracker E2E workflow so repo init can bind the mounted fixture file.
cd "$WORK_DIR"
GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH="/e2e/fixtures/issues.json" \
node /app/packages/cli/dist/index.js repo init

# Create an empty issues.json if none mounted
if [ ! -f /e2e/fixtures/issues.json ]; then
  echo "[]" > /e2e/fixtures/issues.json
fi

# The orchestrator intentionally passes only allowlisted host environment keys
# to workers. Keep the stub scenario in the project-scoped env so the Docker
# TC can select a deterministic worker behavior without widening that allowlist.
printf 'STUB_SCENARIO=%s\n' "${STUB_SCENARIO:-happy}" > \
  "$WORK_DIR/.runtime/orchestrator/projects/repository/.env"
printf 'GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH=/e2e/fixtures/issues.json\n' >> \
  "$WORK_DIR/.runtime/orchestrator/projects/repository/.env"

echo "[entrypoint] Starting CLI orchestrator with HTTP composition..."
node /app/packages/cli/dist/index.js repo start \
  --http 4680 \
  --bind-all &
CLI_PID=$!

forward_signal() {
  kill "$CLI_PID" 2>/dev/null || true
}

trap forward_signal INT TERM

wait "$CLI_PID"
EXIT_CODE=$?
kill "$CLI_PID" 2>/dev/null || true
wait || true
exit "$EXIT_CODE"

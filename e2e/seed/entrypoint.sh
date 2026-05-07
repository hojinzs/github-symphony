#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/e2e/repos/test-owner/test-repo"
WORK_DIR="/e2e/work/test-repo"

# Ensure the tmpfs-backed work root exists.
mkdir -p /e2e/work
rm -rf "$WORK_DIR"
git clone "$REPO_DIR" "$WORK_DIR"
git -C "$WORK_DIR" remote set-url origin test-owner/test-repo

# GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH is intentionally limited to the
# file-tracker E2E workflow so repo init can bind the mounted fixture file.
cd "$WORK_DIR"
GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH="/e2e/fixtures/issues.json" \
node /app/packages/cli/dist/index.js repo init

# Create an empty issues.json if none mounted
if [ ! -f /e2e/fixtures/issues.json ]; then
  echo "[]" > /e2e/fixtures/issues.json
fi

echo "[entrypoint] Starting CLI orchestrator with HTTP composition..."
node /app/packages/cli/dist/index.js repo start \
  --http 4680 &
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

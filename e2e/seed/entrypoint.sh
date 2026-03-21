#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="/app/.runtime"
CONFIG_DIR="$RUNTIME_DIR/projects/e2e-project"

# Ensure runtime directories exist
mkdir -p "$CONFIG_DIR"
mkdir -p /e2e/workspaces

# Place project config where the orchestrator expects it
cp /e2e/seed/config.json "$CONFIG_DIR/project.json"

# Create an empty issues.json if none mounted
if [ ! -f /e2e/fixtures/issues.json ]; then
  echo "[]" > /e2e/fixtures/issues.json
fi

echo "[entrypoint] Starting orchestrator..."
node /app/packages/orchestrator/dist/index.js run \
  --runtime-root /app/.runtime \
  --project-id e2e-project &
ORCHESTRATOR_PID=$!

echo "[entrypoint] Starting dashboard..."
node /app/packages/dashboard/dist/index.js \
  --runtime-root /app/.runtime \
  --project-id e2e-project \
  --host 0.0.0.0 \
  --port 4680 &
DASHBOARD_PID=$!

forward_signal() {
  kill "$ORCHESTRATOR_PID" "$DASHBOARD_PID" 2>/dev/null || true
}

trap forward_signal INT TERM

wait -n "$ORCHESTRATOR_PID" "$DASHBOARD_PID"

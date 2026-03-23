#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="/app/.runtime"
PROJECT_ID="e2e-project"
CONFIG_DIR="$RUNTIME_DIR/projects/$PROJECT_ID"

# Ensure runtime directories exist
mkdir -p "$CONFIG_DIR"
mkdir -p /e2e/workspaces

# Place CLI config where the start command expects it
cat > "$RUNTIME_DIR/config.json" <<EOF
{
  "activeProject": "$PROJECT_ID",
  "projects": ["$PROJECT_ID"]
}
EOF

# Place project config where the CLI/orchestrator expect it
cp /e2e/seed/config.json "$CONFIG_DIR/project.json"

# Create an empty issues.json if none mounted
if [ ! -f /e2e/fixtures/issues.json ]; then
  echo "[]" > /e2e/fixtures/issues.json
fi

echo "[entrypoint] Starting CLI orchestrator with HTTP composition..."
GH_SYMPHONY_CONFIG_DIR="$RUNTIME_DIR" \
node /app/packages/cli/dist/index.js start \
  --project-id "$PROJECT_ID" \
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

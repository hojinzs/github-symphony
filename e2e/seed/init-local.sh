#!/usr/bin/env bash
set -euo pipefail

# Local E2E Initializer — sets up .runtime/ for running E2E tests without Docker.
# Usage: ./e2e/seed/init-local.sh
# Must be run from the repository root.

ROOT_DIR="$(pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
PROJECT_ID="e2e-project"
REPO_DIR="$RUNTIME_DIR/e2e/repos/test-owner/test-repo"
WORKSPACE_DIR="$RUNTIME_DIR/e2e/workspaces"
CONFIG_DIR="$RUNTIME_DIR/projects/$PROJECT_ID"
ISSUES_PATH="$ROOT_DIR/e2e/fixtures/issues.json"
STUB_WORKER_JS="$ROOT_DIR/e2e/dist/stub-worker.js"

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[init-local]${NC} $*"; }

# ── 1. Compile stub worker ──────────────────────────────────────
log "Compiling stub worker..."
mkdir -p e2e/dist
npx tsc e2e/stub-worker.ts \
  --outDir e2e/dist \
  --target ES2022 \
  --module nodenext \
  --moduleResolution nodenext \
  --skipLibCheck

# ── 2. Create bare git repo ─────────────────────────────────────
log "Creating test git repo at $REPO_DIR"
rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"
(
  cd "$REPO_DIR"
  git init --initial-branch=main
  git config user.email "e2e@test.local"
  git config user.name "E2E Test"

  # WORKFLOW.md with local stub-worker path
  cat > WORKFLOW.md << EOF
---
tracker:
  kind: file
  state_field: Status
  active_states:
    - Ready
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  blocker_check_states:
    - Ready
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 2
  max_turns: 2
codex:
  command: node $STUB_WORKER_JS
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
  stall_timeout_ms: 60000
---
You are an AI agent working on issue {{issue.identifier}}.
This is an E2E test environment. Complete the task and report success.
EOF

  git add WORKFLOW.md
  git commit -m "Initial commit with WORKFLOW.md"
)

# ── 3. Create runtime directory structure ────────────────────────
log "Setting up runtime at $RUNTIME_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "$WORKSPACE_DIR"

cat > "$RUNTIME_DIR/config.json" << EOF
{
  "activeProject": "$PROJECT_ID",
  "projects": ["$PROJECT_ID"]
}
EOF

cat > "$CONFIG_DIR/project.json" << EOF
{
  "projectId": "$PROJECT_ID",
  "slug": "$PROJECT_ID",
  "workspaceDir": "$WORKSPACE_DIR",
  "repositories": [
    {
      "owner": "test-owner",
      "name": "test-repo",
      "cloneUrl": "$REPO_DIR"
    }
  ],
  "tracker": {
    "adapter": "file",
    "bindingId": "e2e-test",
    "settings": {
      "issuesPath": "$ISSUES_PATH"
    }
  }
}
EOF

# ── 4. Generate local fixtures (Docker paths → local paths) ──────
DOCKER_CLONE_URL="/e2e/repos/test-owner/test-repo"
LOCAL_FIXTURES_DIR="$RUNTIME_DIR/e2e/fixtures"
mkdir -p "$LOCAL_FIXTURES_DIR"

log "Generating local fixtures..."
for f in "$ROOT_DIR"/e2e/fixtures/*.json; do
  [ -f "$f" ] || continue
  basename="$(basename "$f")"
  sed "s|$DOCKER_CLONE_URL|$REPO_DIR|g" "$f" > "$LOCAL_FIXTURES_DIR/$basename"
done

# ── 5. Initialize empty issues fixture ──────────────────────────
echo "[]" > "$ISSUES_PATH"

log "Done. Local E2E environment ready."
log ""
log "Quick start:"
log "  cp .runtime/e2e/fixtures/happy-path.json e2e/fixtures/issues.json"
log "  pnpm e2e:start"

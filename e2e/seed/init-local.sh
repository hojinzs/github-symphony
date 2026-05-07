#!/usr/bin/env bash
set -euo pipefail

# Local E2E Initializer — sets up .runtime/ for running E2E tests without Docker.
# Usage: ./e2e/seed/init-local.sh
# Must be run from the repository root.

ROOT_DIR="$(pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
REPO_DIR="$RUNTIME_DIR/e2e/repos/test-owner/test-repo"
WORK_DIR="$RUNTIME_DIR/e2e/work/test-repo"
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

# ── 2. Create source git repo ───────────────────────────────────
log "Creating test git repo at $REPO_DIR"
rm -rf "$REPO_DIR" "$WORK_DIR"
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

# ── 3. Clone work repo and initialize repo-local runtime ─────────
log "Cloning work repo to $WORK_DIR"
mkdir -p "$(dirname "$WORK_DIR")"
git clone "$REPO_DIR" "$WORK_DIR"
git -C "$WORK_DIR" remote set-url origin test-owner/test-repo

log "Initializing repo-local runtime at $WORK_DIR/.runtime/orchestrator"
(
  cd "$WORK_DIR"
  GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH="$ISSUES_PATH" \
    node "$ROOT_DIR/packages/cli/dist/index.js" repo init
)

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

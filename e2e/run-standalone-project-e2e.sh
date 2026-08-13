#!/usr/bin/env bash
set -euo pipefail

# This bypasses the repo-embedded entrypoint and dispatches two registered
# standalone projects once against the same local seed repository.
COMPOSE="docker compose -f docker-compose.e2e.yml"

${COMPOSE} build symphony-e2e >/dev/null
${COMPOSE} run --rm --no-deps --entrypoint bash symphony-e2e -lc '
set -euo pipefail

export HOME=/tmp/standalone-home
CONFIG_DIR=/tmp/standalone-config
PROJECT_ROOT=/tmp/standalone-projects
FIXTURE=/tmp/standalone-issues.json

mkdir -p "$HOME"
mkdir -p "$PROJECT_ROOT/project-alpha/.agent/skills/alpha" "$PROJECT_ROOT/project-beta/.agent/skills/beta"
write_project() {
  project_dir=$1
  label=$2
  cat > "$project_dir/WORKFLOW.md" <<EOF
---
tracker:
  kind: file
  project_id: standalone-e2e
  active_states:
    - Ready
  pickup_labels:
    include:
      - $label
    exclude:
      - $(test "$label" = alpha && printf beta || printf alpha)
agent:
  max_concurrent_agents: 1
  max_turns: 1
codex:
  command: codex
repository:
  slug: test-owner/test-repo
workspace:
  root: .runtime/workspaces
---
Standalone E2E project.
EOF
  printf "{\"mcpServers\":{\"%s\":{\"command\":\"node\",\"args\":[\"-e\",\"process.exit(0)\"]}}}\n" "$label" > "$project_dir/.mcp.json"
  printf "STUB_SCENARIO=happy\n" > "$project_dir/.env"
  chmod 600 "$project_dir/.env"
  printf "%s\n" "---" "name: $label" "---" "$label skill" > "$project_dir/.agent/skills/$label/SKILL.md"
}

write_project "$PROJECT_ROOT/project-alpha" alpha
write_project "$PROJECT_ROOT/project-beta" beta

cat > "$FIXTURE" <<EOF
[
  {"id":"standalone-alpha","identifier":"test-owner/test-repo#101","number":101,"title":"alpha","description":null,"priority":null,"state":"Ready","branchName":null,"url":null,"labels":["alpha"],"blockedBy":[],"createdAt":null,"updatedAt":null,"repository":{"owner":"test-owner","name":"test-repo","cloneUrl":"/e2e/repos/test-owner/test-repo"},"tracker":{"adapter":"file","bindingId":"standalone-e2e","itemId":"standalone-alpha"},"metadata":{}},
  {"id":"standalone-beta","identifier":"test-owner/test-repo#102","number":102,"title":"beta","description":null,"priority":null,"state":"Ready","branchName":null,"url":null,"labels":["beta"],"blockedBy":[],"createdAt":null,"updatedAt":null,"repository":{"owner":"test-owner","name":"test-repo","cloneUrl":"/e2e/repos/test-owner/test-repo"},"tracker":{"adapter":"file","bindingId":"standalone-e2e","itemId":"standalone-beta"},"metadata":{}}
]
EOF

for project in project-alpha project-beta; do
  node /app/packages/cli/dist/index.js --config "$CONFIG_DIR" project add "$PROJECT_ROOT/$project"
done
alpha_id=$(node -e "console.log(require(\"$CONFIG_DIR/config.json\").projects[0])")
beta_id=$(node -e "console.log(require(\"$CONFIG_DIR/config.json\").projects[1])")
run_pids=""
for project_id in "$alpha_id" "$beta_id"; do
  node -e "const fs=require(\"fs\"); const path=\"$CONFIG_DIR/projects/$project_id/project.json\"; const config=require(path); config.repository.cloneUrl=\"/e2e/repos/test-owner/test-repo\"; config.tracker.settings.issuesPath=\"$FIXTURE\"; fs.writeFileSync(path, JSON.stringify(config, null, 2)+\"\\n\")"
  GH_SYMPHONY_CONFIG_DIR="$CONFIG_DIR" node /app/packages/orchestrator/dist/index.js run-once --runtime-root "$CONFIG_DIR" --project-id "$project_id" > "/tmp/$project_id.json" 2>&1 &
  run_pids="$run_pids $!"
  for _ in $(seq 1 20); do
    if grep -q "\"dispatched\": 1" "/tmp/$project_id.json"; then break; fi
    sleep 1
  done
  if ! grep -q "\"dispatched\": 1" "/tmp/$project_id.json"; then
    cat "/tmp/$project_id.json" >&2
    exit 1
  fi
done

for _ in $(seq 1 30); do
  completed_logs=$(find "$CONFIG_DIR/projects" -path "*/runs/*/worker.log" -type f -exec grep -l "\\[stub-worker\\] status=completed" {} + 2>/dev/null | wc -l | tr -d " " || true)
  test "$completed_logs" = 2 && break
  sleep 1
done
if [ "${completed_logs:-0}" != 2 ]; then
  for log in $(find "$CONFIG_DIR/projects" -path "*/runs/*/worker.log" -type f); do
    echo "--- $log" >&2
    cat "$log" >&2
  done
  exit 1
fi
bare="$CONFIG_DIR/repos/test-owner/test-repo.git"
test -d "$bare"
test "$(git -C "$bare" rev-parse --is-bare-repository)" = true
test "$(find "$CONFIG_DIR" "$HOME" "$PROJECT_ROOT" -path "*/repos/test-owner/test-repo.git" -type d | wc -l | tr -d " ")" = 1
for project in project-alpha project-beta; do
  label=${project#project-}
  issue=101
  if [ "$label" = beta ]; then issue=102; fi
  project_id="$alpha_id"
  if [ "$label" = beta ]; then project_id="$beta_id"; fi
  repo=$(find "$CONFIG_DIR/projects/$project_id" -path "*/repository" -type d | head -1)
  # A linked worktree records its gitdir in a .git file; a normal checkout
  # uses a directory. Either shape proves the populated workspace is a repo.
  test -e "$repo/.git"
  test -f "$repo/.codex/skills/$label/SKILL.md"
  test -z "$(git -C "$repo" status --porcelain)"
  branch=$(git -C "$repo" branch --show-current)
  expected="symphony/$project/test-owner-test-repo-$issue"
  test "$branch" = "$expected"
  find "$CONFIG_DIR/projects/$project_id" -path "*/runs/*/worker.log" -type f -exec grep -q "\\[stub-worker\\] mcp_servers=$label" {} +
  find "$CONFIG_DIR/projects/$project_id" -path "*/runs/*/worker.log" -type f -exec grep -q "\\[stub-worker\\] status=completed" {} +
done
alpha_repo=$(find "$CONFIG_DIR/projects/$alpha_id" -path "*/repository" -type d | head -1)
beta_repo=$(find "$CONFIG_DIR/projects/$beta_id" -path "*/repository" -type d | head -1)
alpha_branch=$(git -C "$alpha_repo" branch --show-current)
beta_branch=$(git -C "$beta_repo" branch --show-current)
test "$alpha_branch" != "$beta_branch"
for pid in $run_pids; do kill "$pid" 2>/dev/null || true; done
echo "standalone-project Docker E2E passed"
'

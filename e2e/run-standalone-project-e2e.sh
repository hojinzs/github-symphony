#!/usr/bin/env bash
set -euo pipefail

# Dispatch two folder-addressed projects once against the same local seed
# repository.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/e2e/lib/compose-project.sh"
configure_e2e_compose_project "$ROOT_DIR"
COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml)

cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  remove_e2e_compose_image
}

assert_docker_runtime_is_available
assert_e2e_project_is_available docker-compose.e2e.yml
trap cleanup EXIT

"${COMPOSE[@]}" build symphony-e2e >/dev/null
"${COMPOSE[@]}" run --rm --no-deps --entrypoint bash symphony-e2e -lc '
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
  mkdir -p "$project_dir/hooks"
  cp /e2e/seed/hooks/after_create.sh "$project_dir/hooks/after_create.sh"
  chmod +x "$project_dir/hooks/after_create.sh"
  cat > "$project_dir/WORKFLOW.md" <<EOF
---
tracker:
  kind: file
  provider:
    path: \$GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: standalone-e2e
    pickup_labels:
      include:
        - $label
      exclude:
        - $(test "$label" = alpha && printf beta || printf alpha)
  active_states:
    - Ready
hooks:
  after_create: hooks/after_create.sh
agent:
  max_concurrent_agents: 1
  max_turns: 1
codex:
  command: codex
repository:
  slug: test-owner/test-repo
  clone_url: /e2e/repos/test-owner/test-repo
workspace:
  root: .runtime/workspaces
---
Standalone E2E project.
EOF
  printf "{\"mcpServers\":{\"%s\":{\"command\":\"node\",\"args\":[\"-e\",\"process.exit(0)\"]}}}\n" "$label" > "$project_dir/.mcp.json"
  printf "STUB_SCENARIO=happy\nSYMPHONY_ALLOW_WORKFLOW_HOOKS=1\n" > "$project_dir/.env"
  chmod 600 "$project_dir/.env"
  printf "%s\n" "---" "name: $label" "---" "$label skill" > "$project_dir/.agent/skills/$label/SKILL.md"
}

write_project "$PROJECT_ROOT/project-alpha" alpha
write_project "$PROJECT_ROOT/project-beta" beta
write_project "$PROJECT_ROOT/project-broken" broken
rm "$PROJECT_ROOT/project-broken/hooks/after_create.sh"

if (cd "$PROJECT_ROOT/project-broken" && \
  GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH="$FIXTURE" \
  node /app/packages/cli/dist/index.js --config "$CONFIG_DIR" project start \
    > /tmp/project-broken.log 2>&1); then
  echo "missing hook unexpectedly passed project start" >&2
  exit 1
fi
grep -q "Project configuration fault" /tmp/project-broken.log
grep -q "$PROJECT_ROOT/project-broken/hooks/after_create.sh" /tmp/project-broken.log

cat > "$FIXTURE" <<EOF
[
  {"id":"standalone-alpha","identifier":"test-owner/test-repo#101","number":101,"title":"alpha","description":null,"priority":null,"state":"Ready","branchName":null,"url":null,"labels":["alpha"],"blockedBy":[],"createdAt":null,"updatedAt":null,"repository":{"owner":"test-owner","name":"test-repo","cloneUrl":"/e2e/repos/test-owner/test-repo"},"tracker":{"adapter":"file","bindingId":"standalone-e2e","itemId":"standalone-alpha"},"metadata":{}},
  {"id":"standalone-beta","identifier":"test-owner/test-repo#102","number":102,"title":"beta","description":null,"priority":null,"state":"Ready","branchName":null,"url":null,"labels":["beta"],"blockedBy":[],"createdAt":null,"updatedAt":null,"repository":{"owner":"test-owner","name":"test-repo","cloneUrl":"/e2e/repos/test-owner/test-repo"},"tracker":{"adapter":"file","bindingId":"standalone-e2e","itemId":"standalone-beta"},"metadata":{}}
]
EOF

# Both projects run at once against one repository, addressed only by their
# folder: no registration step, no shared active-project state.
run_pids=""
for project in project-alpha project-beta; do
  (cd "$PROJECT_ROOT/$project" && \
    GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH="$FIXTURE" \
    node /app/packages/cli/dist/index.js --config "$CONFIG_DIR" project start \
      > "/tmp/$project.log" 2>&1) &
  run_pids="$run_pids $!"
done
alpha_id=$(node -e "const {createHash}=require(\"crypto\");const d=\"$PROJECT_ROOT/project-alpha\";console.log(\"project-alpha-\"+createHash(\"sha256\").update(d).digest(\"hex\").slice(0,8))")
beta_id=$(node -e "const {createHash}=require(\"crypto\");const d=\"$PROJECT_ROOT/project-beta\";console.log(\"project-beta-\"+createHash(\"sha256\").update(d).digest(\"hex\").slice(0,8))")
for _ in $(seq 1 40); do
  if test -f "$CONFIG_DIR/projects/$alpha_id/project.json" &&
     test -f "$CONFIG_DIR/projects/$beta_id/project.json"; then
    break
  fi
  sleep 1
done
test -f "$CONFIG_DIR/projects/$alpha_id/project.json"
test -f "$CONFIG_DIR/projects/$beta_id/project.json"

for _ in $(seq 1 60); do
  completed_logs=$(find "$CONFIG_DIR/projects" -path "*/runs/*/worker.log" -type f -exec grep -l "\\[stub-worker\\] status=completed" {} + 2>/dev/null | wc -l | tr -d " " || true)
  test "$completed_logs" = 2 && break
  sleep 1
done
if [ "${completed_logs:-0}" != 2 ]; then
  cat /tmp/project-alpha.log /tmp/project-beta.log >&2 || true
  for log in $(find "$CONFIG_DIR/projects" -path "*/runs/*/worker.log" -type f); do
    echo "--- $log" >&2
    cat "$log" >&2
  done
  exit 1
fi
for project in project-alpha project-beta; do
  label=${project#project-}
  issue=101
  if [ "$label" = beta ]; then issue=102; fi
  project_id="$alpha_id"
  if [ "$label" = beta ]; then project_id="$beta_id"; fi
  # Standalone workspaces live under the workspace.root of the project folder,
  # not under the runtime state directory (spec 9.1).
  test -z "$(find "$CONFIG_DIR/projects/$project_id" -path "*/repository" -type d)"
  repo=$(find "$PROJECT_ROOT/$project/.runtime/workspaces" -path "*/repository" -type d | head -1)
  test -d "$repo/.git"
  test -f "$repo/.codex/skills/$label/SKILL.md"
  test -z "$(git -C "$repo" status --porcelain)"
  branch=$(git -C "$repo" branch --show-current)
  expected="symphony/$project/test-owner-test-repo-$issue"
  test "$branch" = "$expected"
  logs=$(find "$CONFIG_DIR/projects/$project_id" -path "*/runs/*/worker.log" -type f -print)
  test -n "$logs"
  grep -q "\\[stub-worker\\] mcp_servers=$label" $logs
  grep -q "\\[stub-worker\\] status=completed" $logs
done
alpha_repo=$(find "$PROJECT_ROOT/project-alpha/.runtime/workspaces" -path "*/repository" -type d | head -1)
beta_repo=$(find "$PROJECT_ROOT/project-beta/.runtime/workspaces" -path "*/repository" -type d | head -1)
alpha_branch=$(git -C "$alpha_repo" branch --show-current)
beta_branch=$(git -C "$beta_repo" branch --show-current)
test "$alpha_branch" != "$beta_branch"
for pid in $run_pids; do kill "$pid" 2>/dev/null || true; done
echo "standalone-project Docker E2E passed"
'

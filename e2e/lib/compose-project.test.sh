#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root_dir/e2e/lib/compose-project.sh"

first=$(e2e_compose_project_name "/tmp/worktree-a")
second=$(e2e_compose_project_name "/tmp/worktree-b")
test "$first" = "$(e2e_compose_project_name /tmp/worktree-a)"
test "$first" != "$second"

SYMPHONY_E2E_PROJECT=debug-project configure_e2e_compose_project /tmp/worktree-a
test "$COMPOSE_PROJECT_NAME" = debug-project
test "$SYMPHONY_E2E_IMAGE" = debug-project:e2e
test "$E2E_IMAGE_IS_DERIVED" = true

unset SYMPHONY_E2E_PROJECT SYMPHONY_E2E_IMAGE SYMPHONY_E2E_PORT
configure_e2e_compose_project /tmp/worktree-a
test "$COMPOSE_PROJECT_NAME" = "$first"
test "$SYMPHONY_E2E_IMAGE" = "$first:e2e"
test "$E2E_IMAGE_IS_DERIVED" = true
test "$SYMPHONY_E2E_PORT" -ge 20000 && test "$SYMPHONY_E2E_PORT" -le 29999
test "$(e2e_compose_port /tmp/worktree-a)" = "$(e2e_compose_port /tmp/worktree-a)"
test "$(e2e_compose_port /tmp/worktree-a)" != "$(e2e_compose_port /tmp/worktree-b)"

export SYMPHONY_E2E_IMAGE=shared-e2e:debug
configure_e2e_compose_project /tmp/worktree-a
test "$SYMPHONY_E2E_IMAGE" = shared-e2e:debug
test "$E2E_IMAGE_IS_DERIVED" = false
unset SYMPHONY_E2E_IMAGE

stub_dir=$(mktemp -d)
trap 'rm -rf "$stub_dir"' EXIT
cat > "$stub_dir/docker" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = compose ] && [ "${2:-}" = version ]; then
  if [ "${E2E_STUB_DOCKER_MODE:-healthy}" = missing-compose ]; then
    echo "docker: unknown command: docker compose" >&2
    exit 1
  fi
  echo "Docker Compose version v2.0.0"
  exit 0
fi
if [ "${1:-}" = info ]; then
  if [ "${E2E_STUB_DOCKER_MODE:-healthy}" = daemon-down ]; then
    echo "Cannot connect to the Docker daemon" >&2
    exit 1
  fi
  exit 0
fi
if [ "${E2E_STUB_PROJECT:-}" = busy-project ]; then
  printf 'container-id\n'
fi
EOF
chmod +x "$stub_dir/docker"

runtime_output=$(PATH="$stub_dir:$PATH" assert_docker_runtime_is_available 2>&1)
test -z "$runtime_output"

set +e
missing_docker_output=$(PATH="$stub_dir/empty" assert_docker_runtime_is_available 2>&1)
missing_docker_status=$?
compose_output=$(HOME=/isolated-home DOCKER_CONFIG=/run/docker-config PATH="$stub_dir:$PATH" \
  E2E_STUB_DOCKER_MODE=missing-compose assert_docker_runtime_is_available 2>&1)
compose_status=$?
daemon_output=$(PATH="$stub_dir:$PATH" E2E_STUB_DOCKER_MODE=daemon-down \
  assert_docker_runtime_is_available 2>&1)
daemon_status=$?
set -e

test "$missing_docker_status" -eq "$E2E_DOCKER_UNAVAILABLE_EXIT"
test "$missing_docker_output" = "[e2e] Docker runtime unavailable: the 'docker' command is not on PATH."
test "$compose_status" -eq "$E2E_DOCKER_UNAVAILABLE_EXIT"
case "$compose_output" in
  *"'docker compose' cannot be resolved"*'$HOME/.docker/cli-plugins/'*"HOME=/isolated-home, DOCKER_CONFIG=/run/docker-config"*"docker: unknown command: docker compose"*) ;;
  *) echo "missing Compose diagnostic was incomplete: $compose_output" >&2; exit 1 ;;
esac

for runner in \
  e2e/run-flat-tracker-keys-e2e.sh \
  e2e/run-standalone-project-e2e.sh \
  test/e2e/claude/run-docker-e2e.sh; do
  preflight_line=$(grep -n -m1 '^assert_docker_runtime_is_available$' "$root_dir/$runner" | cut -d: -f1)
  cleanup_trap_line=$(grep -n -m1 '^trap cleanup EXIT' "$root_dir/$runner" | cut -d: -f1)
  test -n "$preflight_line"
  test -n "$cleanup_trap_line"
  test "$preflight_line" -lt "$cleanup_trap_line"
done
test "$daemon_status" -eq "$E2E_DOCKER_UNAVAILABLE_EXIT"
case "$daemon_output" in
  *"Docker daemon is not reachable"*"Cannot connect to the Docker daemon"*) ;;
  *) echo "daemon diagnostic was incomplete: $daemon_output" >&2; exit 1 ;;
esac

PATH="$stub_dir:$PATH" E2E_STUB_PROJECT=idle-project assert_e2e_project_is_available docker-compose.e2e.yml idle-project
if PATH="$stub_dir:$PATH" E2E_STUB_PROJECT=busy-project assert_e2e_project_is_available docker-compose.e2e.yml busy-project; then
  echo 'busy Compose project was incorrectly accepted' >&2
  exit 1
fi

echo "compose project isolation helpers passed"

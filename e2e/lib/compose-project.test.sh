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

unset SYMPHONY_E2E_PROJECT SYMPHONY_E2E_IMAGE
configure_e2e_compose_project /tmp/worktree-a
test "$COMPOSE_PROJECT_NAME" = "$first"
test "$SYMPHONY_E2E_IMAGE" = "$first:e2e"

echo "compose project isolation helpers passed"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/e2e/lib/fixture-replacement.sh"

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
target="$test_dir/issues.json"
source_fixture="$test_dir/source.json"

printf '%s\n' '[{"id":"original"}]' > "$target"

if atomic_replace_issue_fixture_on_host "$test_dir/missing.json" "$target"; then
  echo "Expected missing source replacement to fail" >&2
  exit 1
fi
test "$(<"$target")" = '[{"id":"original"}]'

printf '%s\n' '[{"id":"replacement"}]' > "$source_fixture"
atomic_replace_issue_fixture_on_host "$source_fixture" "$target"
test "$(<"$target")" = '[{"id":"replacement"}]'
mode=$(stat -f '%Lp' "$target" 2>/dev/null || stat -c '%a' "$target")
test "$mode" = 644

printf '%s\n' '[]' | atomic_replace_issue_fixture_from_stdin_on_host "$target"
test "$(<"$target")" = '[]'
mode=$(stat -f '%Lp' "$target" 2>/dev/null || stat -c '%a' "$target")
test "$mode" = 644

printf '%s\n' '[{"id":"alternate"}]' > "$test_dir/alternate.json"
(
  for _ in $(seq 1 100); do
    atomic_replace_issue_fixture_on_host "$source_fixture" "$target"
    atomic_replace_issue_fixture_on_host "$test_dir/alternate.json" "$target"
  done
) &
writer_pid=$!
while kill -0 "$writer_pid" 2>/dev/null; do
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$target"
done
wait "$writer_pid"

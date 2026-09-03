#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root_dir/e2e/lib/fixture-file.sh"

temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

target="$temp_dir/issues.json"
source_fixture="$temp_dir/source.json"
printf '{"version":"old"}\n' > "$target"
printf '{"version":"new"}\n' > "$source_fixture"

exec 3<"$target"
replace_e2e_issue_fixture "$source_fixture" "$target"

old_contents=$(cat <&3)
new_contents=$(cat "$target")
test "$old_contents" = '{"version":"old"}'
test "$new_contents" = '{"version":"new"}'

echo "atomic fixture replacement passed"

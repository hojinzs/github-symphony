#!/usr/bin/env bash

# Atomically publish a complete issue fixture without exposing a truncated file
# to the file tracker. The source is checked before a temporary target exists,
# so a missing fixture preserves the last valid document.
atomic_replace_issue_fixture_on_host() {
  local source_fixture="$1"
  local target_fixture="$2"
  local temporary

  if [ ! -f "$source_fixture" ]; then
    echo "Missing fixture: $source_fixture" >&2
    return 1
  fi

  temporary=$(mktemp "${target_fixture}.tmp.XXXXXX")
  if ! cp "$source_fixture" "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! chmod 0644 "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! mv "$temporary" "$target_fixture"; then
    rm -f "$temporary"
    return 1
  fi
}

atomic_replace_issue_fixture_from_stdin_on_host() {
  local target_fixture="$1"
  local temporary

  temporary=$(mktemp "${target_fixture}.tmp.XXXXXX")
  if ! cat > "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! chmod 0644 "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! mv "$temporary" "$target_fixture"; then
    rm -f "$temporary"
    return 1
  fi
}

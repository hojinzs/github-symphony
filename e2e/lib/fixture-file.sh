#!/usr/bin/env bash

replace_e2e_issue_fixture() {
  local source_fixture="$1"
  local target_fixture="${2:-e2e/fixtures/issues.json}"
  local temporary_fixture

  temporary_fixture=$(mktemp "${target_fixture}.tmp.XXXXXX")
  if ! cp "$source_fixture" "$temporary_fixture"; then
    rm -f "$temporary_fixture"
    return 1
  fi

  mv "$temporary_fixture" "$target_fixture"
}

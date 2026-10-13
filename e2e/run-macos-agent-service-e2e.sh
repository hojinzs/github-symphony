#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Native LaunchAgent verification requires macOS" >&2
  exit 69
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/symphony-c12-probes.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
node e2e/macos-agent-service-e2e.mjs
for probe in loaded lock survival restart retention; do
  if MACOS_SERVICE_PLANT_FORBIDDEN="$probe" node e2e/macos-agent-service-e2e.mjs >"$scratch/$probe.log" 2>&1; then
    echo "Forbidden $probe unexpectedly passed" >&2
    exit 1
  fi
  case "$probe" in
    loaded) assertion="CP-23 loaded service reports actual PID" ;;
    lock) assertion="CP-23 foreground/service lock conflict rejected" ;;
    survival) assertion="CP-23 stop preserves actual managed project" ;;
    restart) assertion="CP-23 unexpected exit has bounded recovery" ;;
    retention) assertion="CP-23 uninstall preserves enrollment allowlist and journal" ;;
  esac
  if ! rg -Fq "reached: $assertion" "$scratch/$probe.log" || ! rg -Fq AssertionError "$scratch/$probe.log"; then
    echo "$probe failed before its reached assertion" >&2
    tail -30 "$scratch/$probe.log" >&2
    exit 1
  fi
  echo "$probe assertion reached and failed as required"
done
echo "macOS agent service native E2E passed"

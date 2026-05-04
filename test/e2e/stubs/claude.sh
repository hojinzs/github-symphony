#!/usr/bin/env bash
set -euo pipefail

# Stub Claude Code print-mode shim contract:
# - stdin: accepts newline-delimited stream-json messages and records them for
#   blackbox assertions; message contents are not interpreted.
# - stdout: emits a fixed NDJSON sequence of message_start,
#   content_block_delta, and result records for supported success scenarios.
# - argv: detects --session-id <id>, --resume <id>, and --fork-session. A
#   --resume value simulates accepting existing session context; --fork-session
#   returns a deterministic replacement session id in the result record.
# - scenarios: selected with CLAUDE_STUB_SCENARIO. Supported values are success,
#   retry-then-success, inter-run-recover, rate-limit, and
#   session-invalid-on-resume.
# - exit modes: success scenarios exit 0. CLAUDE_STUB_EXIT_MODE=process-error
#   or the first rejected resume in session-invalid-on-resume exits non-zero.
# - observability: each invocation appends argv/stdin/session metadata to
#   ${CLAUDE_STUB_LOG_DIR:-$PWD/.claude-stub}/invocations.ndjson.

scenario="${CLAUDE_STUB_SCENARIO:-success}"
exit_mode="${CLAUDE_STUB_EXIT_MODE:-success}"
log_dir="${CLAUDE_STUB_LOG_DIR:-$PWD/.claude-stub}"
mkdir -p "$log_dir"

invocations_file="$log_dir/invocations.ndjson"
counter_file="$log_dir/invocation-count"
if [[ -f "$counter_file" ]]; then
  invocation="$(($(cat "$counter_file") + 1))"
else
  invocation=1
fi
printf '%s\n' "$invocation" > "$counter_file"

session_id=""
resume_id=""
fork_session=false
args_json="["
first_arg=true

json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' -- "$1"
}

append_arg() {
  if [[ "$first_arg" == true ]]; then
    first_arg=false
  else
    args_json+=","
  fi
  args_json+="$(json_string "$1")"
}

while (($# > 0)); do
  arg="$1"
  append_arg "$arg"

  case "$arg" in
    --session-id)
      if (($# < 2)); then
        printf 'claude stub: --session-id requires a value\n' >&2
        exit 64
      fi
      shift
      session_id="$1"
      append_arg "$session_id"
      ;;
    --resume)
      if (($# < 2)); then
        printf 'claude stub: --resume requires a value\n' >&2
        exit 64
      fi
      shift
      resume_id="$1"
      append_arg "$resume_id"
      ;;
    --fork-session)
      fork_session=true
      ;;
  esac
  shift || true
done
args_json+="]"

stdin_file="$log_dir/stdin-${invocation}.ndjson"
cat > "$stdin_file"

if [[ -n "$resume_id" ]]; then
  effective_session_id="$resume_id"
elif [[ -n "$session_id" ]]; then
  effective_session_id="$session_id"
else
  effective_session_id="stub-session-${invocation}"
fi

if [[ "$fork_session" == true ]]; then
  result_session_id="forked-${effective_session_id}-${invocation}"
else
  result_session_id="$effective_session_id"
fi

stdin_json="$(node -e '
const fs = require("fs");
const path = process.argv[1];
const raw = fs.readFileSync(path, "utf8").trim();
const lines = raw ? raw.split(/\n/) : [];
process.stdout.write(JSON.stringify(lines));
' "$stdin_file")"

INVOCATION="$invocation" \
SCENARIO="$scenario" \
ARGS_JSON="$args_json" \
STDIN_JSON="$stdin_json" \
SESSION_ID="$session_id" \
RESUME_ID="$resume_id" \
FORK_SESSION="$fork_session" \
RESULT_SESSION_ID="$result_session_id" \
INVOCATIONS_FILE="$invocations_file" \
node -e '
const fs = require("fs");
const record = {
  invocation: Number(process.env.INVOCATION),
  scenario: process.env.SCENARIO,
  argv: JSON.parse(process.env.ARGS_JSON),
  stdin: JSON.parse(process.env.STDIN_JSON),
  sessionId: process.env.SESSION_ID || null,
  resumeId: process.env.RESUME_ID || null,
  forkSession: process.env.FORK_SESSION === "true",
  resultSessionId: process.env.RESULT_SESSION_ID,
};
fs.appendFileSync(process.env.INVOCATIONS_FILE, JSON.stringify(record) + "\n");
'

invalid_marker="$log_dir/session-invalid-resume-rejected"
if [[ "$scenario" == "session-invalid-on-resume" && -n "$resume_id" && ! -f "$invalid_marker" ]]; then
  printf '1\n' > "$invalid_marker"
  printf 'resume session %s rejected with HTTP 404\n' "$resume_id" >&2
  exit 1
fi

if [[ "$exit_mode" == "process-error" ]]; then
  printf 'stub process error for scenario %s\n' "$scenario" >&2
  exit 2
fi

case "$scenario" in
  success | retry-then-success | inter-run-recover | session-invalid-on-resume)
    printf '{"type":"message_start","message":{"id":"msg-%s","role":"assistant"},"session_id":"%s"}\n' "$invocation" "$result_session_id"
    printf '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stub turn %s complete"},"session_id":"%s"}\n' "$invocation" "$result_session_id"
    printf '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":11,"output_tokens":5},"session_id":"%s"}\n' "$result_session_id"
    ;;
  rate-limit)
    printf '{"type":"message_start","message":{"id":"msg-%s","role":"assistant"},"session_id":"%s"}\n' "$invocation" "$result_session_id"
    printf '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"rate limited"},"session_id":"%s"}\n' "$result_session_id"
    printf '{"type":"result","subtype":"error_rate_limit","is_error":true,"message":"429 rate limit","usage":{"input_tokens":7,"output_tokens":3,"rate_limit":{"reset_at":"2099-01-01T00:00:00.000Z"}},"session_id":"%s"}\n' "$result_session_id"
    ;;
  *)
    printf 'claude stub: unsupported scenario %s\n' "$scenario" >&2
    exit 64
    ;;
esac

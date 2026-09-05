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
#   or the first rejected resume in session-invalid-on-resume emits Claude
#   Code's terminal structured error result and exits non-zero.
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
mcp_config_path=""
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
    --mcp-config)
      if (($# < 2)); then
        printf 'claude stub: --mcp-config requires a value\n' >&2
        exit 64
      fi
      shift
      mcp_config_path="$1"
      append_arg "$mcp_config_path"
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

host_mcp_json="null"
if [[ "${CLAUDE_STUB_CALL_HOST_MCP:-false}" == "true" && -n "$mcp_config_path" ]]; then
  host_mcp_json="$(MCP_CONFIG_PATH="$mcp_config_path" node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.env.MCP_CONFIG_PATH, "utf8"));
const server = config.mcpServers && config.mcpServers.symphony;
if (Object.keys(config.mcpServers || {}).join(",") !== "symphony") {
  throw new Error("child MCP configuration must expose only symphony HTTP");
}
if (!server || typeof server.url !== "string" || !server.headers) {
  throw new Error("host MCP configuration is missing symphony");
}
if (server.type !== "http") {
  throw new Error("host MCP configuration must use Streamable HTTP");
}
(async () => {
  const calls = [
    { query: "query { viewer { login } }" },
    {
      query: "mutation AddComment($subjectId: ID!, $body: String!) { addComment(input: { subjectId: $subjectId, body: $body }) { commentEdge { node { id } } } }",
      variables: { subjectId: "issue-worker-claude", body: "host-side comment" },
    },
    {
      query: "mutation UpdateState($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id } } }",
      variables: { projectId: "stub-project", itemId: "item-worker-claude", fieldId: "status-field", value: { singleSelectOptionId: "in-review" } },
    },
  ];
  const responses = [];
  for (const [index, argumentsValue] of calls.entries()) {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `stub-host-tool-call-${index}`,
        method: "tools/call",
        params: { name: "github_graphql", arguments: argumentsValue },
      }),
    });
    responses.push({ status: response.status, payload: await response.json() });
  }
  process.stdout.write(JSON.stringify({
    url: server.url,
    responseStatus: responses.at(-1).status,
    result: responses.at(-1).payload.result,
    error: responses.at(-1).payload.error,
    calls: responses,
  }));
})().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
' )"
fi

INVOCATION="$invocation" \
SCENARIO="$scenario" \
ARGS_JSON="$args_json" \
STDIN_JSON="$stdin_json" \
SESSION_ID="$session_id" \
RESUME_ID="$resume_id" \
FORK_SESSION="$fork_session" \
RESULT_SESSION_ID="$result_session_id" \
HOST_MCP_JSON="$host_mcp_json" \
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
  hostMcp: JSON.parse(process.env.HOST_MCP_JSON || "null"),
  childBoundary: {
    home: process.env.HOME || null,
    ghConfigDir: process.env.GH_CONFIG_DIR || null,
    gitConfigCount: Boolean(process.env.GIT_CONFIG_COUNT),
    gitCredentialHelper: Boolean(process.env.GIT_CONFIG_VALUE_0),
  },
  trackerCredentialEnvironment: {
    githubGraphqlToken: Boolean(process.env.GITHUB_GRAPHQL_TOKEN),
    githubToken: Boolean(process.env.GITHUB_TOKEN),
    ghToken: Boolean(process.env.GH_TOKEN),
    githubTokenBrokerSecret: Boolean(process.env.GITHUB_TOKEN_BROKER_SECRET),
    linearApiKey: Boolean(process.env.LINEAR_API_KEY),
    linearAuthorization: Boolean(process.env.LINEAR_AUTHORIZATION),
  },
  environment: { ...process.env },
};
fs.appendFileSync(process.env.INVOCATIONS_FILE, JSON.stringify(record) + "\n");
'

invalid_marker="$log_dir/session-invalid-resume-rejected"
if [[ "$scenario" == "session-invalid-on-resume" && -n "$resume_id" && ! -f "$invalid_marker" ]]; then
  printf '1\n' > "$invalid_marker"
  # Claude Code print mode reports a rejected resume as a terminal stream-json
  # result. Keep this fixture aligned with the observed CLI protocol so the
  # adapter E2E exercises structured rejection detection rather than the
  # removed stderr/HTTP-status heuristic.
  printf '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"%s","errors":["No conversation found with session ID: %s"]}\n' "$resume_id" "$resume_id"
  printf 'No conversation found with session ID: %s\n' "$resume_id" >&2
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

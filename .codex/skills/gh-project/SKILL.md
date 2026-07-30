---
name: gh-project
description: Request run-scoped tracker states and transitions through the orchestrator.
license: MIT
metadata:
  author: gh-symphony
  version: "2.0"
  generatedBy: "gh-symphony"
---

# /gh-project — Orchestrator-owned Tracker State

## Purpose

Request issue-scoped tracker state reads and transitions from the orchestrator,
then write lifecycle comments only after confirmed success.

## Prerequisites

- `SYMPHONY_ORCHESTRATOR_URL` is set by the current run
- `SYMPHONY_RUN_ID` identifies and authorizes the current run
- The orchestrator owns the canonical tracker item, provider quota, retry/backoff, mutation, and readback

## Operations

### Read Current Issue State

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$SYMPHONY_ORCHESTRATOR_URL/api/v1/tracker-state" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Run-Id: $SYMPHONY_RUN_ID" \
  --data '{"type":"state-read"}'
```

### Request Issue Status Transition

```bash
expected_state="In progress"
target_state="In review"
reason="PR created; validation passed"
payload=$(jq -n \
  --arg expected "$expected_state" \
  --arg target "$target_state" \
  --arg reason "$reason" \
  '{type:"transition-request", expected_state:$expected, target_state:$target, reason:$reason}')
response=$(curl --fail-with-body --silent --show-error \
  -X POST "$SYMPHONY_ORCHESTRATOR_URL/api/v1/tracker-state" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Run-Id: $SYMPHONY_RUN_ID" \
  --data "$payload")
printf "%s\n" "$response"
jq -e --arg target "$target_state" \
  '.ok == true and .outcome == "confirmed" and .state == $target' <<<"$response"
```

### Create Workpad Comment

Use `gh issue comment --body-file <file>` for multi-line comments.

### Update Existing Comment

Use `gh api -X PATCH /repos/<owner>/<repo>/issues/comments/<comment-id> -F body=@<file>`.

## Rules

- Always follow the `WORKFLOW.md` status map.
- Never traverse provider boards or mutate tracker fields directly from a worker.
- Treat non-2xx responses, expected-state mismatches, and readback mismatches as failed transitions.
- Post transition comments and update the workpad only after `.ok == true`, `.outcome == "confirmed"`, and the returned state matches the target.
- Before transitioning to a terminal state, verify the Completion Bar and merged PR requirements.

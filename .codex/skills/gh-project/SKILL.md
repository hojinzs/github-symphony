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
writing lifecycle comments before the request and correcting them if it fails.

## Prerequisites

- `SYMPHONY_ORCHESTRATOR_URL` is set by the current run
- `SYMPHONY_RUN_ID` identifies the current run
- `SYMPHONY_ORCHESTRATOR_TOKEN` authenticates the worker without exposing the credential through status APIs
- The orchestrator owns the canonical tracker item, provider quota, retry/backoff, mutation, and readback

## Operations

### Read Current Issue State

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$SYMPHONY_ORCHESTRATOR_URL/api/v1/tracker-state" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Run-Id: $SYMPHONY_RUN_ID" \
  -H "X-Symphony-Orchestrator-Token: $SYMPHONY_ORCHESTRATOR_TOKEN" \
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
  -H "X-Symphony-Orchestrator-Token: $SYMPHONY_ORCHESTRATOR_TOKEN" \
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
- Post the transition comment and workpad line **before** sending the transition request. A confirmed transition into a non-active state makes the issue ineligible, and reconciliation can terminate this worker mid-turn, so anything deferred until after the response may never be written.
- When the response is not `.ok == true`, `.outcome == "confirmed"`, and the returned state matching the target, immediately post the `⚠️ Status transition failed` correction comment and workpad line (WORKFLOW.md Posture 5). A failed transition leaves the worker running, so the correction always lands.
- Before transitioning to a terminal state, verify the Completion Bar and merged PR requirements.

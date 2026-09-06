---
name: gh-project
description: Request run-scoped tracker states and transitions through the orchestrator, and manage issue comments through the host-side github_graphql tool.
license: MIT
metadata:
  author: gh-symphony
  version: "3.0"
  generatedBy: "gh-symphony"
---

# /gh-project — Orchestrator-owned Tracker State

## Purpose

Request issue-scoped tracker state reads and transitions from the orchestrator,
while keeping issue-comment authorship in the worker and its agents.

## Prerequisites

- `SYMPHONY_ORCHESTRATOR_URL` is set by the current run
- `SYMPHONY_RUN_ID` identifies the current run
- `SYMPHONY_ORCHESTRATOR_TOKEN` authenticates the worker without exposing the credential through status APIs
- The orchestrator owns the canonical tracker item, provider quota, retry/backoff, mutation, and readback
- The worker child has **no** GitHub credentials: `gh` is unauthenticated. Use the `github_graphql` tool for every GitHub read or write.

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

Prepare the status comment separately, then send only transition intent. Run this
script verbatim so every value is JSON-encoded by `jq`:

```bash
expected_state="In progress"
target_state="In review"
reason="PR ready; Completion Bar passed"
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

Only after the response confirms the requested state, publish the separately
prepared exact status body with the host-side `github_graphql` `addComment`
mutation. If the transition fails, do not publish it.

### Create Workpad or Issue Comment (`github_graphql`)

Load the body from the scratch file into the tool variables (for example `jq -n --arg id "$issue_id" --rawfile body "$scratch/workpad.md" '{subjectId:$id, body:$body}'`), then call:

```graphql
mutation AddIssueComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge {
      node {
        id
        url
      }
    }
  }
}
```

The issue node id comes from:

```graphql
query IssueContext($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {
      id
      comments(last: 50) {
        nodes {
          id
          body
          author {
            login
          }
          createdAt
        }
      }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
        nodes {
          id
          number
          url
          state
          isDraft
          merged
          headRefName
          baseRefName
          reviewDecision
          mergeCommit {
            oid
          }
        }
      }
    }
  }
}
```

### Update Existing Comment

```graphql
mutation UpdateIssueComment($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) {
    issueComment {
      id
    }
  }
}
```

### Create Follow-up Issue

```graphql
mutation CreateFollowUp(
  $repositoryId: ID!
  $title: String!
  $body: String!
  $labelIds: [ID!]
) {
  createIssue(
    input: {
      repositoryId: $repositoryId
      title: $title
      body: $body
      labelIds: $labelIds
    }
  ) {
    issue {
      number
      url
    }
  }
}
```

## Rules

- Always follow the `WORKFLOW.md` status map.
- Never traverse provider boards or mutate tracker fields directly from a worker; never touch ProjectV2 objects through `github_graphql`.
- Treat non-2xx responses, expected-state mismatches, and readback mismatches as failed transitions.
- Never send `comment_body` to the tracker-state API; it accepts transition intent only.
- Keep the transition reason and intended comment body in the workpad before requesting the transition. A failed transition produces no status comment and remains recoverable in the current worker.
- Publish the prepared status body through `github_graphql` only when the response is `.ok == true`, `.outcome == "confirmed"`, and the returned state matches the target.
- Before creating a workpad, re-query the newest comments and adopt an existing workpad with the same cycle number.
- Before transitioning to a terminal state, verify the Completion Bar and merged PR requirements.

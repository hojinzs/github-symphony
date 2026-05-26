---
name: gh-project
description: Manage GitHub Project v2 issue states, workpad comments, and related follow-up actions.
license: MIT
metadata:
  author: gh-symphony
  version: "2.0"
  generatedBy: "gh-symphony"
---

# /gh-project — GitHub Project v2 Status Management

## Purpose

Interact with the GitHub Project v2 board to manage issue status,
create workpad comments, and handle follow-up issues.

## Prerequisites

- `gh` CLI is authenticated (`gh auth status`)
- `.gh-symphony/context.yaml` exists with field IDs and option IDs

## Column ID Quick Reference

**Project:** 🧩 Moncher Stack (`PVT_kwHOAPiKdM4BYPVD`, hojinzs/projects/14)
**Status Field ID:** `PVTSSF_lAHOAPiKdM4BYPVDzhTWkPc`

| Column Name | Role     | Option ID  |
| ----------- | -------- | ---------- |
| Backlog     | wait     | `ecd228db` |
| Ready       | active   | `f043e389` |
| In progress | active   | `b734c33a` |
| In review   | wait     | `ffe0efa5` |
| Land        | active   | `161b1b30` |
| Done        | terminal | `444fc1b2` |

## Operations

### Change Issue Status

Use `gh project item-edit` with the field ID and option ID from the table above:

```bash
# Get the project item ID for an issue
gh project item-list <project-number> --owner <owner> --format json \
  | jq '.items[] | select(.content.number == <issue-number>) | .id'

# Update the status field
gh project item-edit \
  --project-id PVT_kwHOAPiKdM4BYPVD \
  --id <item-id> \
  --field-id PVTSSF_lAHOAPiKdM4BYPVDzhTWkPc \
  --single-select-option-id <option-id-from-table-above>
```

### Create Workpad Comment

```bash
gh issue comment <issue-number> --repo <owner>/<repo> --body "## Workpad\n\n### Plan\n- [ ] Task 1"
```

### Update Existing Comment

```bash
gh api -X PATCH /repos/<owner>/<repo>/issues/comments/<comment-id> \
  -f body="## Workpad\n\n### Plan\n- [x] Task 1 (done)"
```

### Create Follow-up Issue

```bash
gh issue create --repo <owner>/<repo> \
  --title "Follow-up: <title>" \
  --body "<description>" \
  --label "backlog"
```

### Add Label

```bash
gh issue edit <issue-number> --repo <owner>/<repo> --add-label "<label>"
```

## Rules

- Always follow the WORKFLOW.md status map flow for state transitions
- Before transitioning to a terminal state, verify the Completion Bar is satisfied:
  - All acceptance criteria checked
  - All tests passing
  - PR merged (if applicable)
- Use the Column ID Quick Reference table above for all status transitions
- Do not transition issues to terminal states without explicit completion verification

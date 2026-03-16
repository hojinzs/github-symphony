---
name: status
description: Display a dashboard of all project issues grouped by status, showing priority, size, estimate, and blocking relationships. Use when you want to see the current state of the project board.
disable-model-invocation: true
user-invocable: true
---

# /project-manager:status — Project Status Dashboard

## Purpose

Display a comprehensive overview of all issues on the GitHub Project board, grouped by status column, with priority, size, estimate, and blocking relationship information.

## Pre-flight Checks

Run these checks **in order** before proceeding:

1. **gh CLI authentication**: Run `gh auth status`. If not authenticated, stop and instruct:
   ```
   GitHub CLI is not authenticated. Please run:
   $ gh auth login
   ```

2. **Project scope permission**: Attempt a lightweight project API call. If permission error, stop and instruct:
   ```
   The GitHub CLI token lacks the "project" scope. Please run:
   $ gh auth refresh -s project
   ```

3. **PROJECT_MANAGE.md exists**: Read `PROJECT_MANAGE.md` from the repository root. If not found, stop and instruct:
   ```
   PROJECT_MANAGE.md not found. Please run /project-manager:init first.
   ```

## Workflow

### Step 1: Parse Configuration

Read `PROJECT_MANAGE.md` frontmatter to get:
- `project_number`, `owner` — for querying the project
- `status_options` — for ordering status columns correctly
- `backlog_status` — to identify which items are in backlog

### Step 2: Fetch All Project Items

Run `gh project item-list <project_number> --owner <owner> --format json --limit 100` to get all items with their fields.

For each item, extract:
- Title, number, issue URL
- Status (which column)
- Priority (P0/P1/P2 or unset)
- Size (XS~XL or unset)
- Estimate (number or unset)
- Labels
- Assignees

### Step 3: Fetch Blocking Relationships

For items that are **not Done**, fetch their blocking relationships. Use GraphQL to query `blockedBy` and `blocking` edges on each issue:

```graphql
query {
  repository(owner: "<owner>", name: "<repo>") {
    issue(number: <N>) {
      blockedBy(first: 10) { nodes { number title state } }
      blocking(first: 10) { nodes { number title state } }
    }
  }
}
```

Batch these queries when possible to minimize API calls (combine multiple issues into a single GraphQL query using aliases).

### Step 4: Render Dashboard

Display issues grouped by Status column, ordered by the project's column order. Within each group, sort by Priority (P0 first), then by issue number.

Format:

```
## In Progress (2)
  #26 [P0] blockedBy BlockerRef 변경        S   2d  assignee  ← ready

## Backlog (5)
  #27 [P1] Issue-Centric State Model       XL   8d  assignee  ← ready
  #25 [P1] GET /api/v1/<issue_identifier>   M   3d  assignee  ⊘ blocked by #27
  #22 [P2] Commander.js 마이그레이션        L   5d  assignee  ← ready
  #23 [P2] interactive project selection    S   2d  assignee  ⊘ blocked by #22
  #24 [P2] project add 간소화              S   1d  assignee  ⊘ blocked by #22

## Done (10)
  (show count only, or list with --all flag)
```

Status indicators:
- `← ready` — No unresolved blockers, can be started
- `⊘ blocked by #N` — Has unresolved blocking issues
- `⊘ blocked by #N (Done)` — Blocker is marked done but relationship not yet removed (stale)
- No priority/size/estimate → show `[--]`, `--`, `--` to highlight missing fields

### Step 5: Show Summary

At the bottom, display aggregate statistics:

```
## Summary
  Total: 17 issues | In Progress: 2 | Backlog: 5 | Done: 10
  Blocked: 3 | Ready to start: 4
  Backlog estimate: 21d | Untriaged: 0
```

- **Untriaged**: Backlog items missing Priority, Size, or Estimate. If > 0, suggest running `/project-manager:triage`.
- **Blocked**: Items with at least one unresolved blocker.
- **Ready to start**: Non-Done items with no unresolved blockers.

## Important Rules

- **Done items**: Show only a count by default to keep the dashboard readable. The user can ask for full details if needed.
- **Blocking relationships**: Only show active (non-Done) blockers as blocking. If a blocker is Done, flag it as stale.
- **Missing fields**: Visually highlight items that lack Priority, Size, or Estimate so the user knows what needs triage.
- **API efficiency**: Batch GraphQL queries to avoid excessive API calls. Combine multiple issue queries into a single request using field aliases.
- Keep the output concise. This is a dashboard, not a report.

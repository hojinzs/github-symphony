---
name: project-manager
description: Manage a repository's GitHub Project workflow through PROJECT_MANAGE.md. Use when setting up project management for a repo, creating structured issues from implementation requests, triaging backlog items with Priority/Size/Estimate, analyzing blocking relationships across open issues, or rendering a project status dashboard.
---

# Project Manager

## Overview

Use this skill to keep a repository's GitHub Project workflow consistent around a single source of truth: `PROJECT_MANAGE.md` at the repo root.

Prefer `gh` CLI for Project v2 operations that are not covered well by other tools. Use repository-local evidence from the codebase before assigning Priority, Size, Estimate, or blockers.

## Choose The Workflow

Pick the path that matches the user's request:

- Initialize project management configuration: create `PROJECT_MANAGE.md` with real project IDs, field IDs, option IDs, and repository-specific conventions.
- Create new issues: turn a natural-language work request into one or more concrete issues, then add them to the project and set fields.
- Triage backlog: evaluate backlog issues missing Priority, Size, or Estimate, then propose missing blocker relationships.
- Show status: render a concise dashboard grouped by project status with blocker awareness.

## Shared Checks

Run these checks before any workflow:

1. Run `gh auth status`. If authentication is missing, stop and instruct the user to run `gh auth login`.
2. Verify project scope with a lightweight project call such as `gh project list --owner <owner> --limit 1`. If it fails for permissions, stop and instruct the user to run `gh auth refresh -s project`.
3. Resolve the repository from `git remote get-url origin` before creating or editing issues.

Use exact IDs fetched from GitHub. Never guess project field IDs or single-select option IDs.

## Initialize PROJECT_MANAGE.md

Use this path when the repo does not yet have `PROJECT_MANAGE.md`.

1. Check whether `PROJECT_MANAGE.md` already exists. If it does, ask before overwriting.
2. Identify the project board:
   - If the user gave a project URL, parse the owner and project number from it.
   - Otherwise inspect `gh project list --owner <owner> --format json` and pick the correct board.
3. Fetch the project node ID with `gh project view <number> --owner <owner> --format json`.
4. Fetch fields with `gh project field-list <number> --owner <owner> --format json`.
5. Detect:
   - `Status` single-select field and every option name to option ID mapping.
   - `Priority` single-select field if present.
   - `Size` single-select field if present.
   - `Estimate` number field if present.
6. Determine which Status option is the backlog state. Prefer `Backlog` if it exists; otherwise ask the user to choose.
7. Infer or discuss conventions:
   - Issue body template sections. Derive a default by reading a few recent issues with `gh issue list --json number,title,body --limit 5`.
   - Splitting threshold. Default to reviewing `L` and above for splitting.
   - Priority definitions. Keep them conservative: `P0` for active bugs or blockers, `P1` for core architectural/spec work, `P2` for less critical work.
   - Size definitions. Base them on files changed, package scope, and interface impact.
   - Estimate unit. Default to full-time developer days unless the repo already uses something else.
8. Write `PROJECT_MANAGE.md` in two parts:
   - YAML frontmatter containing project URL, project number, project node ID, owner, backlog status, backlog status ID, field IDs, and option maps.
   - Markdown sections containing the agreed conventions.
9. Show the generated content before writing if the user asked for confirmation or if any inferred conventions are uncertain.

Use this frontmatter shape:

```yaml
---
project_url: https://github.com/orgs/<owner>/projects/<number>
project_number: 1
project_node_id: PVT_kw...
owner: <owner>
backlog_status: Backlog
backlog_status_id: <option-id>
field_ids:
  status: <field-id>
  priority: <field-id>
  size: <field-id>
  estimate: <field-id>
priority_options:
  P0: "<option-id>"
size_options:
  S: "<option-id>"
status_options:
  Backlog: "<option-id>"
---
```

## Create New Issues

Use this path when the user describes work and wants one or more issues created.

1. Read `PROJECT_MANAGE.md`. If missing, stop and direct the user to initialize first.
2. Parse the frontmatter and conventions.
3. Explore the codebase to understand the request:
   - affected files and packages
   - interfaces or contracts likely to change
   - required tests or verification steps
4. Draft issue bodies using the repo's issue template from `PROJECT_MANAGE.md`.
5. Assign Priority, Size, and Estimate from both the conventions and the actual codebase scope.
6. Decide whether the work should be split:
   - Split when the estimated size crosses the repository's threshold.
   - Keep each split issue independently deliverable when possible.
   - Respect package boundaries and avoid circular dependencies.
7. Inspect all open, non-Done project items to find cross-status dependencies. An `In Progress` issue may block a new backlog issue and should be treated as such.
8. Present the proposed issue set before creating anything:
   - titles
   - issue body previews
   - Priority / Size / Estimate
   - split map if applicable
   - blocker relationships to new or existing issues
9. Only after confirmation:
   - create issues with `gh issue create`
   - add each issue to the project board
   - set project fields using the node IDs from `PROJECT_MANAGE.md`
   - connect blocker relationships
10. Report the created issue URLs and final dependency map.

Issue bodies must be concrete. Include real file paths, real module names, and executable verification steps rather than placeholders.

## Triage Backlog And Dependencies

Use this path when backlog issues need Priority, Size, Estimate, or missing blocker links.

1. Read `PROJECT_MANAGE.md`.
2. Fetch project items and filter to issues in the configured backlog status.
3. Identify backlog items missing any of Priority, Size, or Estimate.
4. For each untriaged item:
   - read the issue body carefully
   - inspect the referenced code and nearby callers/tests
   - assess file count, package boundaries, interface changes, and verification cost
   - assign Priority, Size, and Estimate using the repository's definitions
5. Present a review table before applying changes. Include a short rationale per issue.
6. Apply only after user confirmation.
7. Then analyze blocker relationships across all open, non-Done issues, not just backlog items:
   - data dependencies
   - structural dependencies
   - logical prerequisites
   - rework avoidance
8. Fetch existing blocker relationships first to avoid duplicates.
9. Present a dependency map with each issue's current project status, then apply only after user confirmation.
10. Suggest an execution order:
   - Phase 0 for already in-flight blockers
   - later phases for newly unblocked work
   - separate tracks when independent work can proceed in parallel

Do not modify Priority, Size, or Estimate on non-backlog items unless the user explicitly asks.

## Show Project Status

Use this path when the user wants a dashboard of the current board.

1. Read `PROJECT_MANAGE.md` for the project number, owner, and ordered status options.
2. Fetch all project items with their fields.
3. For non-Done issues, fetch blocker relationships in batches.
4. Render a concise dashboard grouped by status column and ordered by the project's status order.
5. Inside each status group, sort by Priority first and then issue number.
6. Mark each issue as:
   - ready when there are no unresolved blockers
   - blocked when at least one active blocker remains
   - stale when a blocker link points to a Done issue
7. Show counts and summary metrics:
   - total issues
   - counts by status
   - blocked count
   - ready count
   - backlog estimate total
   - untriaged backlog count

Keep Done items compact by default. Expand them only when the user asks for full detail.

## Operational Rules

- Never create issues or mutate project fields without explicit user approval after presenting the plan.
- Never hardcode field IDs or option IDs.
- Use batched GraphQL queries when fetching issue node IDs or blocker relationships at scale.
- Treat blocker analysis as cross-status work. Backlog-only analysis is insufficient.
- Prefer concise outputs. Dashboards and triage summaries should be readable at a glance.

---
name: gh-pr-writeup
description: Draft, create, and update GitHub pull requests for implementation work. Use when opening or refreshing a PR that must clearly link the issue, include concise evidence from pre-PR validation, and add a human validation checklist for reviewers.
---

# /gh-pr-writeup — GitHub PR Writeup Workflow

## Trigger

Use this skill when creating or updating a GitHub PR for an implementation issue.

## Flow

1. Confirm the issue number and repository context before drafting the PR body.
2. Run a small but relevant validation pass before opening or refreshing the PR.
3. Capture the exact commands you ran and the scope they validated.
4. Draft or update the PR body using the template below.
5. Create the PR if none exists; otherwise edit the existing PR so the body stays current.

## Minimum Validation

Before the PR is created or updated, run the smallest meaningful automated check that covers the changed area.

- Prefer targeted commands over full-repo suites when the change scope is narrow.
- Use repository defaults when the scope is broad: `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`.
- If no automated test is available, record the gap explicitly in `Evidence` and explain the fallback manual check.

## PR Body Template

Use this structure unless the repository already has a stricter template:

```md
## Issues

- Fixes #<issue-number>

## Summary

- Short outcome summary
- Key behavior change

## Changes

- Implementation detail 1
- Implementation detail 2

## Evidence

- `command run before PR`
- `another command`
- Manual check: what was verified and where

## Human Validation

- [ ] Confirm the main user flow works as expected
- [ ] Confirm there is no obvious regression in adjacent behavior
- [ ] Confirm reviewer-visible behavior matches the issue requirements

## Risks

- Remaining risk, rollout caveat, or reviewer focus area
```

## Rules

- Put the linked issue under `## Issues` and use an auto-close keyword such as `Fixes #<issue-number>`.
- Keep `Human Validation` unchecked; it is for humans, not the agent.
- In `Evidence`, include concrete commands or concrete manual checks, not vague statements like "tests passed".
- When updating an existing PR after review, refresh `Summary`, `Changes`, and `Evidence` so they describe the latest diff.
- If validation could not run, say exactly why in `Evidence` and in the final handoff.

## Commands

Use GitHub CLI if available:

```bash
gh pr create --title "<title>" --body-file <file>
gh pr edit <pr-number> --title "<title>" --body-file <file>
gh pr view --json number,title,body,url
```

## Related Skills

- `/pull` — sync branch with latest base before PR handoff when needed
- `/push` — publish verified commits before creating or updating the PR
- `/land` — merge approved PRs after checks and approvals are green

---
name: land
description: Merge an approved PR during the Land state. Runs pre-flight checks, performs squash merge, completes post-merge bookkeeping, and transitions the issue to Done.
license: MIT
metadata:
  author: gh-symphony
  version: "1.0"
---

# /land — Land State Merge Workflow

## Trigger

Use this skill only when the issue is in the `Land` state. A human has approved the PR and the remaining job is to merge it safely and complete required post-merge bookkeeping.

Work unattended. Do not ask humans for follow-up. Stop only on a genuine blocker (see *Failure Handling*).

## Operating Rules

- Use `/gh-project` for every Status field change. Never call ProjectV2 GraphQL APIs directly.
- Use `/pull` when the head branch is behind its PR base — never `git merge`/`git rebase` by hand inside this skill.
- All issue/PR comments are in the issue's report language; written via `gh ... --body-file <file>`, never with inline `\n` strings.
- Never modify the issue body.
- Never hardcode `origin/main` for branch-freshness checks — always use the PR's actual base branch (it may be an Epic working branch).
- **Squash merge only** for this repository. Other merge strategies are not used.
- Record every merge attempt, blocker, and outcome in the Land cycle workpad comment.

## Required Context

Before acting, collect:

1. Issue: state, identifier, title, labels, description, URL, repository.
2. Land cycle workpad comment for this issue. (Step 4 created it. If absent, create one before proceeding.)
3. PR: number, URL, base branch, head branch, `mergeStateStatus`, reviews, CI checks, head SHA.
4. Changeset file path, if the issue carries a `changeset:major|minor|patch` label.

If no PR is linked to the issue, record the blocker in the workpad and exit.

## Pre-flight Checks

All must pass before merging. If any fails, record the failure in the workpad and **do not** merge.

1. **At least one human approval.** `gh pr view <pr-number> --json reviews --jq '[.reviews[] | select(.state == "APPROVED")] | length'` must be ≥ 1.
2. **All required CI checks green.** `gh pr checks <pr-number>` — no failing or pending required checks.
3. **Branch up-to-date with the PR base.**
   ```bash
   base=$(gh pr view <pr-number> --json baseRefName --jq .baseRefName)
   git fetch origin "$base"
   git merge-base --is-ancestor "origin/$base" HEAD
   ```
   If behind: run `/pull`, then **re-run the full pre-flight sequence from step 1** (pushing the rebase invalidates prior CI runs and any prior approval).
4. **Changeset present if labeled.** If the issue has a `changeset:major|minor|patch` label, confirm at least one `.changeset/*.md` file exists on the head branch (excluding `README.md` / `config.json`). If absent, record the blocker, do not merge.
5. **PR mergeable.** `gh pr view <pr-number> --json mergeStateStatus --jq .mergeStateStatus` must be `CLEAN` / `HAS_HOOKS` / `UNSTABLE` (the last allowed only when failing checks are all non-required). `BLOCKED` / `DIRTY` / `BEHIND` → not mergeable.
6. **Land cycle workpad reflects the current Land phase.** It should already have the `🔁 Status: In review → Land` transition recorded by Step 4.

## Flow

1. Load context and run all Pre-flight Checks.
2. If the PR is already merged, skip the merge command; run post-merge steps idempotently.
3. Otherwise squash-merge with branch deletion: `gh pr merge <pr-number> --squash --delete-branch`.
4. Capture the merge commit SHA: `gh pr view <pr-number> --json mergeCommit --jq .mergeCommit.oid`.
5. Update the Land cycle workpad's `### Validation` section: merge commit SHA, changeset path (if any), timestamp.
6. Post the standalone `🔁 Status: Land → Done` comment (cycle close: land) and append the matching workpad Status Transitions line.
7. Transition the issue to `Done` via `/gh-project`.
8. Update the workpad's `### Progress Log` with the final outcome.

## Failure Handling

1. Record the exact failure (command, exit code, output excerpt, timestamp) in the workpad `### Progress Log`.
2. If recoverable in this run (e.g. branch behind → run `/pull`), do so and re-run pre-flight from scratch.
3. After **3 consecutive failures of the same step (same cause)**, stop: write a `⛔ Blocker` issue comment with what · why · how to unblock, leave the issue in `Land` (do **not** auto-transition to `Backlog` — Land failures are usually merge-policy issues, not code-blockers), and exit. A human resolves and either re-enters `Land` or moves the issue elsewhere.

## Guardrails

- Do not merge without ≥1 approval and green required CI.
- Do not use merge / rebase / auto-merge — only squash with branch deletion.
- Do not transition the issue to `Done` before the merge succeeds.
- Do not call ProjectV2 GraphQL APIs directly; use `/gh-project`.
- Do not modify the issue body.
- Do not auto-move a failed Land to `Backlog` — leave the human-resolvable state visible.
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

Work unattended. Do not ask humans for follow-up. Stop only on a genuine blocker (see _Failure Handling_).

## Operating Rules

- Use `/gh-project` for every tracker state read/transition. Never traverse provider boards or mutate tracker fields directly.
- Use `/pull` when the head branch is behind its PR base — never `git merge`/`git rebase` by hand inside this skill.
- All issue/PR comments are in the issue's report language; written via `gh ... --body-file <file>`, never with inline `\n` strings.
- Never modify the issue body.
- Never hardcode `origin/main` for branch-freshness checks — always use the PR's actual base branch (it may be an Epic working branch).
- **Squash merge only** for this repository. Other merge strategies are not used.
- Record every merge attempt, blocker, and outcome in the Land cycle workpad comment.
- Treat a Project status transition as the final lifecycle mutation for the Land turn. Before requesting it, finish the pre-flight/merge decision, write its exact evidence and reason into the workpad Validation/Progress Log, and post the standalone transition comment plus the matching Status Transitions line. Nothing but the failure correction may remain after the request — a confirmed transition out of `Land` makes the issue non-active, and reconciliation can terminate this worker mid-turn before deferred bookkeeping runs.

## Required Context

Before acting, collect:

1. Issue: state, identifier, title, labels, description, URL, repository.
2. Land cycle workpad comment for this issue. (Step 4 created it. If absent, create one before proceeding.)
3. PR: number, URL, base branch, head branch, `mergeStateStatus`, reviews, CI checks, head SHA.
4. Changeset file path, if the issue carries a `changeset:major|minor|patch` label.

If no PR is linked to the issue, record the blocker in the workpad and exit.

**Sibling skills.** This skill delegates to `/gh-project` for the Done transition and `/pull` for branch freshness. Both were updated alongside this skill to target the Moncher Stack project and accept the PR's actual base branch — no special workaround is required. If either fails at runtime (e.g. authentication, board re-configuration), record the specific failure in the workpad and exit with a `⛔ Blocker` comment.

## Pre-flight Checks

All must pass before merging. If any fails, record the failure in the workpad and **do not** merge.

1. **At least one human approval.** `gh pr view <pr-number> --json reviews --jq '[.reviews[] | select(.state == "APPROVED")] | length'` must be ≥ 1.
2. **All required CI checks green.** Use `gh pr checks <pr-number> --required` — no failing or pending **required** checks. Optional checks do not gate Land pre-flight. Before `/pull`, capture the required-check names from `gh pr checks <pr-number> --required --json name,bucket`. If no required checks are configured, this gate passes and must not wait for a check suite. If this run's `/pull` or another fresh head update has re-queued previously observed required CI:
   - First poll `gh pr checks <pr-number> --required --json name,bucket` every 10 seconds until the previously observed required checks appear. Do not invoke `--watch` while the result is empty: GitHub can register a new head before its check suite exists, and `--watch` exits immediately when no checks are reported.
   - Keep `Land` while waiting for registration, for at most 5 minutes. If no required check appears by then, classify it as an external CI-registration wait, record the exact head SHA and polling evidence in the workpad, then follow Failure Handling step 5 (`Land` → `In review`). Do not hide GitHub API/authentication errors as an empty result; those are external blockers.
   - Once required checks appear, wait with `gh pr checks <pr-number> --required --watch --interval 10`. Do not transition to `In review` merely because newly-triggered required CI is still running. Once the checks reach terminal states, restart the full pre-flight from step 1.
3. **Branch up-to-date with the PR base.**
   ```bash
   base=$(gh pr view <pr-number> --json baseRefName --jq .baseRefName)
   git fetch origin "$base"
   git merge-base --is-ancestor "origin/$base" HEAD
   ```
   If behind: run `/pull`, then **re-run the full pre-flight sequence from step 1** (pushing the rebase invalidates prior CI runs and any prior approval).
4. **Changeset present if labeled.** If the issue has a `changeset:major|minor|patch` label, confirm at least one `.changeset/*.md` file exists on the head branch (excluding `README.md` / `config.json`). If absent, record the blocker, do not merge.
5. **PR mergeable.** `gh pr view <pr-number> --json mergeStateStatus --jq .mergeStateStatus` must be `CLEAN` / `HAS_HOOKS` / `UNSTABLE` (the last allowed only when failing checks are all non-required). `BLOCKED` / `DIRTY` / `BEHIND` → not mergeable.

## Flow

1. Load context and run all Pre-flight Checks. While loading context, verify the Land cycle workpad has the `🔁 Status: In review → Land` transition line recorded by Step 4; if the workpad is present but the transition line is missing, append it before running pre-flight (this is a recoverable inconsistency, not a blocker).
2. If the PR is already merged, skip the merge command; run post-merge steps idempotently.
3. Otherwise squash-merge with branch deletion: `gh pr merge <pr-number> --squash --delete-branch`.
4. Capture the merge commit SHA: `gh pr view <pr-number> --json mergeCommit --jq .mergeCommit.oid`.
5. Update the Land cycle workpad's `### Validation` and `### Progress Log` sections with merge commit SHA, changeset path (if any), timestamp, and the exact `Land → Done` reason. Complete all Land-cycle evidence before the tracker transition.
6. Post the standalone `🔁 Status: Land → Done` comment (cycle close: land) and append the matching workpad Status Transitions line. Do not defer any outcome details until after the transition.
7. Transition the issue to `Done` via `/gh-project` as the last action of the turn (WORKFLOW.md Posture 5 ordering). If the orchestrator does not return `ok: true`, `outcome: confirmed`, and exact-item readback state `Done`, post the failure correction comment and workpad line.

## Failure Handling

1. Record the exact failure (command, exit code, output excerpt, timestamp) in the workpad `### Progress Log`.
2. If immediately recoverable in this run (branch behind → run `/pull`), do so and re-run pre-flight from scratch. If `/pull` fails, classify that failure using step 5.
3. Do not retry a non-recoverable Land pre-flight failure on later polling turns. First write its concrete classification, command output excerpt, timestamp, and exact transition reason into the workpad; then close the Land cycle after the orchestrator confirms the transition readback, and keep the standalone transition comment and workpad `### Status Transitions` line in sync.
4. **Required CI pending or registering** — when a pre-refresh check found one or more required checks, keep `Land` while those required checks are registering or running. Poll `gh pr checks <pr-number> --required --json name,bucket` every 10 seconds until the previously observed required checks appear (maximum 5 minutes), then wait with `gh pr checks <pr-number> --required --watch --interval 10`. If no required checks were configured before the fresh head, this gate passes without a registration wait. When checks complete, restart all pre-flight checks. A failed required check is a rework failure; a green result proceeds to merge. If expected required checks do not register within the limit, record the head SHA and polling evidence, then classify it as the external wait-only failure in step 5. Do not use `Land` → `In review` solely because CI was re-queued by `/pull` or another fresh head update.
5. **Approval or other external wait-only failure** — no human `APPROVED` review or another condition awaiting human/external review after CI is terminal: post the standalone transition comment first, naming the concrete gate that failed, the head SHA it was evaluated against, and what a human must do; then transition `Land` → `In review` via `/gh-project`. This is not a `⛔ Blocker`.
6. **Rework failure** — failed required CI, merge conflict, missing labeled Changeset, unresolved actionable review feedback, or another PR/code condition the worker can address: post the standalone transition comment with reason `Land-return rework: <cause>`, then transition `Land` → `Ready` via `/gh-project`. The Ready-return rework guard must open the next work cycle and route the item to `In progress`; do not treat it as a fresh pickup.
7. **External or permission blocker** — missing required context, authentication/board failure, or an external dependency the worker cannot resolve: write a `⛔ Blocker` comment with what · why · how to unblock, post the standalone transition comment stating the unblock condition, then transition `Land` → `Backlog` via `/gh-project`.

## Guardrails

- Do not merge without ≥1 approval and green required CI.
- Do not use merge / rebase / auto-merge — only squash with branch deletion.
- Do not transition the issue to `Done` before the merge succeeds.
- Do not traverse provider boards or mutate tracker fields directly; use `/gh-project`.
- Do not modify the issue body.
- Do not leave a non-recoverable failure in active `Land`; return it to `In review`, `Ready`, or `Backlog` according to Failure Handling.

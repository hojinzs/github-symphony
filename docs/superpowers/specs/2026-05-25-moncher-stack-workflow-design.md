# Moncher Stack Workflow + `/land` Skill — Design

**Date:** 2026-05-25
**Status:** Draft (awaiting user approval)
**Owner:** hojinzs
**Related:** [fleabucket-v2 WORKFLOW.md](https://github.com/HJ-company/fleabucket-v2/blob/main/WORKFLOW.md), [fleabucket-v2 `.codex/skills/land/SKILL.md`](https://github.com/HJ-company/fleabucket-v2/blob/main/.codex/skills/land/SKILL.md)

## Goal

Repoint the github-symphony orchestration base from project `PVT_kwHOAPiKdM4BRs_j` to the user-level "🧩 Moncher Stack" project [hojinzs/projects/14](https://github.com/users/hojinzs/projects/14/views/2) (`PVT_kwHOAPiKdM4BYPVD`) and adopt that project's `Land` state by porting the fleabucket-v2 workflow model — *In review = pure wait, Land = active merge step* — into [WORKFLOW.md](../../../WORKFLOW.md) and a new `.codex/skills/land/SKILL.md`.

## Scope decisions

- **Depth — Approach A: Lean alignment.** Adopt fleabucket-v2's *structural* changes (Land state routing, In-review pure wait, Ready-return rework guard, cycle-per-workpad, status transition logging) but keep github-symphony's *domain-specific* details (single-impl flow, changeset policy, `pnpm lint/test/typecheck/build` without turbo, language detection from issue body, no OpenSpec / no Evidence Browser).
- **Skill location:** `.codex/skills/land/SKILL.md` (matching fleabucket-v2 layout; discovered by the codex runtime that the worker spawns).
- **Out of scope for this spec:**
  - Touching `e2e/seed/WORKFLOW.md` (separate fixture lifecycle — different `project_id: e2e-test`, different stub).
  - Migrating existing in-flight issues from the old project board.
  - Building skills other than `/land` (`/gh-project`, `/gh-pr-writeup`, `/commit`, `/push`, `/pull` are referenced but their creation/update is tracked in *Implementation follow-ups*).

## 1. WORKFLOW.md frontmatter

```yaml
tracker:
  kind: github-project
  project_id: PVT_kwHOAPiKdM4BYPVD   # 🧩 Moncher Stack (hojinzs/projects/14)
  state_field: Status
  active_states:
    - Ready
    - In progress
    - Land
  terminal_states:
    - Done
  blocker_check_states:
    - Ready
```

Other frontmatter keys (`polling`, `workspace`, `hooks`, `agent`, `codex`) remain unchanged.

## 2. Status Map

Replace the bullet list with a 6-row table:

| Status | Role | Agent Action |
| ------ | ---- | ------------ |
| **Backlog** | wait | Agent ignores. Exit quietly without commenting. Also the parking lane for code-blocked issues — agent moves the issue here with a `⛔ Blocker` comment when a blocker is hit; human resolves and moves back to `Ready`. |
| **Ready** | active | Triage scope and clarity. If a linked PR exists with unresolved review feedback, treat as a **rework re-entry** (see *Ready-return rework guard* in Step 0) and open a new work cycle before any code change. |
| **In progress** | active | Implement → test → create or update PR. Each work cycle gets exactly one workpad comment; within the same cycle, update it in place. |
| **In review** | wait | Pure human-review wait. Agent does **nothing** here except: if the PR has been merged, transition to `Done`; otherwise exit. Review rework is initiated by a human moving the issue back to `Ready` (or by the human approving and moving it to `Land`). |
| **Land** | active | The human has approved the PR. Run `/land` skill: pre-flight checks (approval, CI, branch freshness) → squash merge → post-merge actions → transition to `Done`. |
| **Done** | terminal | Completed. Agent exits immediately. |

## 3. Default Posture (renumbered, 11 items)

1. Unattended orchestration session. Do not ask humans for follow-up actions.
2. **Blocker = code-blocking only.** A blocker is something that prevents the *code change itself* from being completed (missing required secret, unrecoverable test-infra failure, contradictory requirements that need a human decision). Review feedback, deploy concerns, and UI polish are **not** blockers. On a code-blocker: post a `⛔ Blocker` issue comment (what · why · how to unblock), transition Status → `Backlog` via `/gh-project`, then exit. Never leave a blocked issue in `In progress` with a draft PR.
3. Final message: report only completed work and blockers. No "next steps".
4. **Report language**: detect from the issue body and apply consistently to workpad, progress/blocker/transition comments, and PR review replies. If the language is unclear or mixed, default to English. Keep code, commands, identifiers, and raw tool output in their original form when translating reports.
5. **Log every status transition publicly** in *two* places, before or in the same operation as the board update:
   - A standalone issue comment (`gh issue comment --body-file`), formatted:
     ````
     🔁 Status: `FROM` → `TO`

     Reason: <why now>
     Cycle: <N> open|close
     ````
   - One append-only line in the current workpad's `### Status Transitions` section, newest last:
     ````
     - <ISO-8601 UTC ts> · `<FROM>` → `<TO>` · <reason> (cycle <N> open|close)
     ````
   Reason = *why this transition now*, not a restatement of the target state ("리뷰 blocking 2건 rework", not "moved to In progress").
6. Issue cards are the canonical project item for planning, workpad lifecycle, and state transitions. The PR card supplies PR context only. If an issue has an open PR, inspect it from the issue timeline before deciding whether to create a new branch.
7. If the issue re-enters `Ready`, `In progress`, or `Land` while a PR already exists, treat that as a **new work cycle**: run the relevant guard (Step 0 *Ready-return rework guard* for `Ready`; the `/land` skill's pre-flight for `Land`) and create a **new workpad comment** for the cycle before any code change. Within the same cycle, always update the existing workpad in place — never create a second workpad comment.
8. Use the `/gh-project` skill for all project-board status transitions and field updates. Do not call ProjectV2 GraphQL APIs directly when this skill applies.
9. **Multi-line GitHub comments**: never pass escaped `\n` strings as `--body`. Write the body to a temporary markdown file and post with `gh ... --body-file <file>`. Applies to issue comments, PR comments, and review replies — including the standalone transition comment in Posture 5.
10. Do not edit the issue body for planning or progress tracking.
11. If you discover out-of-scope improvements during the work, open a separate issue rather than expanding the current scope.

## 4. Step 0 — Determine current state and route

```
1. Read {{issue.state}} and detect the report language from the issue body before writing any human-facing text.
2. Route by state:
   - Backlog → exit quietly.
   - Ready → run Ready-return rework guard, then proceed to Step 1 (or Step 2 if reclassified as rework).
   - In progress → run stalled-handoff safety net, then proceed to Step 2.
   - In review → proceed to Step 3.
   - Land → proceed to Step 4.
   - Done → exit immediately.
   - Other → leave a short blocker comment in the report language, then exit.
```

### Ready-return rework guard

When entering `Ready`, before treating it as fresh pickup / board drift / resume:

1. Find linked/open PRs from the issue/project item, the current workpad, and `gh pr list --search "<issue-number>"`.
2. For each linked/open PR, read `reviewDecision`, the latest human reviews, inline review comments (`gh api repos/<owner>/<repo>/pulls/<N>/comments --paginate`), top-level PR comments, recent issue comments.
3. If any linked/open PR has `CHANGES_REQUESTED`, unresolved actionable review comments, or a human instruction indicating rework, this `Ready` state means **review rework return** — not a fresh pickup and not drift.
4. For rework return: open a new work cycle (new `## Workpad` comment), post the standalone `🔁 Status: Ready → In progress` comment, transition via `/gh-project`, then proceed to Step 2 and execute the rework preamble (read all feedback, distill blockers, plan). Do **not** transition back to `In review` until feedback is addressed, Completion Bar passes again, every inline comment has a reply, and re-review is requested.
5. Otherwise (no actionable feedback on any linked PR): proceed to Step 1 normally as a fresh pickup or resume.

### Stalled-handoff safety net

When entering `In progress`, before continuing implementation, check: if the agent-verifiable Completion Bar (Step 2.6) is already met, the PR is still **Draft**, and there is no open `⛔ Blocker` comment, then the previous turn missed the handoff. Run Step 2.8 (changeset → PR ready / refresh body → status comment → transition to `In review`) immediately this turn — do not look for more Plan work. This rescues an issue that would otherwise sit stalled on the next polling tick.

## 5. Step 1 — Ready triage

Entered only when the Step 0 guard classified the entry as **fresh pickup or resume**. Rework returns are routed directly to Step 2.

1. Read the issue body and existing comments to understand the requested work.
2. **Triage actionability:**
   - Requirements unclear → write a triage comment in the report language requesting clarification, post the `🔁 Status: Ready → Backlog` transition log (Posture 5), transition via `/gh-project`, exit.
   - Scope too large (likely >20 files or >3 packages) → write a triage comment requesting issue splitting, post the transition log, transition to `Backlog`, exit. State explicitly whether the reason is unclear requirements, oversized scope, or both.
3. **Resume check (idempotent).** If a `feat/<issue-number>-…` branch or Draft PR for this issue already exists from a prior cycle, adopt them — do **not** recreate.
4. **Open the new work cycle:**
   - Create a new `## Workpad — {{issue.identifier}} — Cycle N` comment using the Workpad Template. N = (most recent existing workpad cycle on this issue) + 1, or 1 if none.
   - Determine the base branch: `main` by default. If the issue body explicitly references an Epic working branch, use that.
   - Create `feat/<issue-number>-<short-description>` from the base branch (unless the resume check above adopted one).
   - Push the branch and create a **Draft PR** targeting the same base branch via the `/gh-pr-writeup` skill (TL;DR · 변경 지점 다이어그램 · 여기부터 보세요 · 위험 & 롤백 · 변경 파일 · `## Issues — Closed #<N>` · 머지 후/사람 확인 placeholders — finalized in Step 2.8).
   - Record the Draft PR URL and base branch in the workpad.
5. Post the standalone `🔁 Status: Ready → In progress` comment (cycle N open), append the matching workpad Status Transitions line, then transition via `/gh-project`.
6. Proceed to Step 2.

## 6. Step 2 — In progress / Execution

Entered from one of:

- **Step 1** (fresh pickup / resume) — first work cycle, Draft PR already exists.
- **Step 0 Ready-return rework guard** — new rework cycle, Draft PR already exists.
- **Step 0 stalled-handoff safety net** — skip directly to Step 2.8.

1. **Workpad continuity.** Continue updating the current cycle's workpad in place. Never create a second workpad for the same cycle.

2. **Rework preamble — only when entered via rework return.** Before any code change:
   - Read all PR review activity: latest reviews, top-level PR comments, inline review comments (`gh api repos/<owner>/<repo>/pulls/<N>/comments --paginate`), failing checks.
   - Distill the main merge blockers into a prioritized list and record them in the workpad `### Rework / PR Feedback` section with the revised plan.
   - As you address each inline comment, reply to it in the report language with a concrete resolution summary or rationale. Never leave an inline comment unanswered.

3. **Implementation — one Plan item per turn.** Explore relevant code, implement, write/update tests, commit in logical units (conventional commit format). Push to the branch after each turn — the Draft PR auto-updates.

4. **Turn-end checklist.** Before ending a turn:
   - workpad Plan item marked `[x]` and a Progress Log entry added.
   - Any status transition this turn is logged (standalone comment + workpad Status Transitions line).
   - All changes committed; no broken intermediate state.
   - **Resting-state rule** — ending a turn in `In progress` is valid only when **(a)** an unchecked, in-scope Plan item remains, or **(b)** a code-blocker was hit, parked to `Backlog` per Posture 2.

5. **Re-verify against the original issue** (coverage, not mechanics). Re-read `{{issue.description}}` requirement-by-requirement and match each one to a file/test that satisfies it. If anything is unmet or partial, add a Plan item and handle it next turn — do not mark the PR ready.

6. **Completion Bar — agent-verifiable.** All must hold before marking the PR ready:
   - [ ] All in-scope requirements from the issue description are implemented.
   - [ ] `pnpm lint` passes.
   - [ ] `pnpm test` passes.
   - [ ] `pnpm typecheck` passes.
   - [ ] `pnpm build` passes.
   - [ ] If the change affects integration behavior (orchestrator dispatch, worker lifecycle, tracker adapters, status API, etc.), a short TC was added and a Docker E2E blackbox run completed per [AGENT_TEST.md](../../../AGENT_TEST.md). Results recorded in the workpad `### Validation` section.
   - [ ] Tests written for new functionality (or justified N/A and noted).
   - [ ] Code follows the conventions in [CLAUDE.md](../../../CLAUDE.md) (strict TypeScript, Prettier, conventional commits).
   - [ ] All inline review comments answered (rework cycles only).

7. **Changeset policy — mandatory immediately before marking the PR ready (or before re-handoff after rework).**
   - If the issue has one of `changeset:major`, `changeset:minor`, `changeset:patch`, create a Changeset.
   - The release package must be `@gh-symphony/cli` only. Do not add private/internal workspace packages.
   - Bump type follows the label; with multiple labels, use the highest impact (`major` > `minor` > `patch`) and note the ambiguity in the workpad.
   - The Changeset summary describes the user-visible CLI/runtime behavior change and references the issue identifier when practical.
   - Record the Changeset file path in the workpad `### Validation` section.

8. **Mandatory handoff gate.** The moment Steps 5–7 are satisfied, in **this same turn**:
   1. Run `/gh-pr-writeup` to refresh the PR body so TL;DR · 변경 지점 다이어그램 · 여기부터 보세요 · 위험 & 롤백 · 변경 파일 · `## Issues — Closed #<N>` · 머지 후/사람 확인 sections are current.
   2. Mark the Draft PR ready: `gh pr ready <pr-number>`.
   3. Post the standalone `🔁 Status: In progress → In review` comment (cycle N close).
   4. Append the matching workpad Status Transitions line; tick the Completion Bar items; record final Validation results; close the cycle marker.
   5. Transition the issue to `In review` via `/gh-project`.

   **Never end a turn with the Completion Bar met and the PR still Draft.** That state deadlocks the workflow (Step 3 only fires on merge; the worker won't be re-dispatched). The Step 0 stalled-handoff safety net rescues it on the next polling tick as a backstop, but it should not be needed.

## 7. Step 3 — In review (pure wait)

`In review` is **not** in `active_states`, so the dispatcher does not normally wake the worker here. If invoked at this state (e.g. a PR-card merge event triggers re-dispatch, or a future poll catches a stale in-review issue whose PR was merged outside the normal flow), perform a single defensive check:

1. If the PR has been merged: refresh the merged commit SHA into the workpad, post the standalone `🔁 Status: In review → Done` comment (cycle close), append the matching workpad Status Transitions line, transition to `Done` via `/gh-project`, exit.
2. Otherwise: exit immediately. Do **not** process review feedback. Do **not** reply to inline comments. Do **not** transition the issue.

Rework feedback is initiated by a human moving the issue back to `Ready` — the Step 0 *Ready-return rework guard* then opens the rework cycle (Step 2). PR approval and the actual merge happen when a human moves the issue to `Land` — Step 4 (`/land`) performs the squash merge.

## 8. Step 4 — Land

**Trigger:** `{{issue.state}}` = `Land`. A human has approved the PR and moved the issue here.

1. **Open the land cycle.** Create a new `## Workpad — {{issue.identifier}} — Cycle N (Land)` comment (do not reuse the prior `In progress` cycle's workpad). Post the standalone `🔁 Status: In review → Land` comment (cycle N open: land), append the matching workpad Status Transitions line.

2. **Invoke the `/land` skill** (defined at `.codex/skills/land/SKILL.md`). The skill is responsible for:
   - Pre-flight checks (approval, required CI checks, base-branch freshness, changeset presence if labeled).
   - Running `/pull` if the branch is behind, then re-running pre-flight from scratch.
   - Squash merge: `gh pr merge <pr-number> --squash --delete-branch`.
   - Recording the merged commit SHA and changeset path (if any) in the workpad.
   - Transitioning the issue to `Done` via `/gh-project` only after the merge succeeds.

3. **Close the land cycle.** Once `/land` completes the Done transition, ensure the standalone `🔁 Status: Land → Done` comment was posted and the workpad Status Transitions line was appended (cycle N close: land).

4. **On `/land` failure.** The skill records the failure and exits. If the same step fails 3 consecutive times for the same cause, write a `⛔ Blocker` comment, do **not** transition the issue, exit. A human resolves the cause and either moves the issue back to `In review` (sends Step 4 home as a no-op next time) or re-enters `Land` after fixing the underlying problem.

This step performs no code edits, commits, or pushes itself — only the workpad/comment bookkeeping around the skill call. Any rework code change must come through the `In review` → `Ready` → Step 2 path.

## 9. Workpad Lifecycle

A **work cycle** is one continuous active stretch on an issue. It opens when the issue enters an active state from a wait/terminal state, and closes when it returns to a wait/terminal state. Turns are sub-units inside a cycle.

| Transition | Cycle effect |
| ---------- | ------------ |
| (any wait state) → `Ready` → `In progress` | open **cycle N** (fresh pickup or resume) |
| `In progress` → `In review` | close current cycle (handoff to human) |
| `In review` → `Ready` → `In progress` (via Ready-return rework guard) | open **next cycle** (rework) |
| `In progress` → `Backlog` (code-blocker) | close current cycle (parked) |
| `Backlog` → `Ready` (resume after blocker resolved) | open **next cycle** (resume) |
| `In review` → `Land` | open a **land cycle** |
| `Land` → `Done` | close the land cycle (terminal) |

**Rules:**

- Each cycle gets exactly **one** `## Workpad — {{issue.identifier}} — Cycle N` comment.
- Within a cycle, **edit** the existing workpad in place. Never create a second workpad for the same cycle.
- When a new cycle opens, create a **new** workpad comment. Prior cycle workpads remain as historical audit records — do not silently rewrite them.
- The "current" workpad is the newest open cycle comment. Identify it by searching for the most recent comment whose body starts with `## Workpad —`.
- Cycle number N increments across the whole issue lifetime — including land cycles. (Example: cycle 1 initial work, cycle 2 rework, cycle 3 land.) Cycles open on a transition into `In progress` (Step 1.5 / Step 0 Ready-return guard step 4) or `Land` (Step 4.1); transitions into intermediate active states like `Ready` do not open a cycle.
- Triage failures (`Ready` → `Backlog` from Step 1.2) do **not** open or close a cycle. The standalone status comment is still posted, but the `Cycle:` line is written as `Cycle: — (triage rejection)`. The next cycle number is unaffected.

## 10. Workpad Template

Used for all cycles. Land-cycle workpads keep Plan/Validation/Progress Log filled and leave Completion Bar / Rework empty.

````md
## Workpad — {{issue.identifier}} — Cycle {N}

**Type:** {fresh pickup | rework cycle (PR #X) | resume after blocker | land}
**Branch:** {branch name}
**Draft PR:** {PR URL or `not yet created`}
**Cycle opened:** {ISO ts} · **Trigger:** {one-line reason}

### Status Transitions

<!-- append-only within this cycle; also post each transition as a standalone issue comment -->
- {ISO ts} · `{FROM}` → `{TO}` · {why now} (cycle {N} open|close)

### Plan

<!-- one item per turn (Step 2.3). LAST item is always the handoff.
     Out-of-scope items go under 위임 below, never here. -->
- [ ] 1. {task item}
- [ ] N. 마무리: 원본 이슈 재검증 · Completion Bar 통과 · changeset (필요 시) · PR ready · In review 전이

### Rework / PR Feedback

<!-- only filled on rework cycles entered via Step 0 Ready-return guard -->
- Major merge blockers from review:
  - {blocker 1}

### Completion Bar

<!-- mirror of WORKFLOW.md Step 2.6; in-progress cycles only -->
- [ ] In-scope requirements implemented
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] Docker E2E (if integration behavior changed)
- [ ] Tests for new functionality (or justified N/A)
- [ ] Code conventions (CLAUDE.md)
- [ ] Inline review comments answered (rework only)

### Validation

<!-- evidence: command, outcome, artifacts -->
- {command} — {pass/fail}
- Changeset: `{path or N/A}`
- Docker E2E evidence: `{path or N/A}`
- Merge commit (Land cycle only): `{SHA}`

### 위임 (out-of-scope / human / post-merge)

<!-- items from {{issue.description}} that the agent does NOT do: deploy,
     external URL smoke test, manual UX. Mirror into the PR body's
     머지 후/사람 확인 section. NOT blockers, NOT Plan checkboxes. -->
- {none | item}

### Progress Log

- {ISO ts}: {action taken}

### Blockers

<!-- code-blockers only (Posture 2). On a code-blocker: write ⛔ here + as a
     standalone issue comment, then park Status → Backlog. -->
None
````

## 11. Related Skills (in WORKFLOW.md)

All skills referenced by this workflow live under `.codex/skills/<name>/SKILL.md`.

- **`/gh-project`** — manage GitHub Project v2 status transitions and board placement. All Status field changes go through this skill (Posture 8).
- **`/gh-pr-writeup`** — scaffold or refresh the PR body. Two modes:
  - *Initial Draft* (Step 1): create a new Draft PR with the section skeleton + `## Issues — Closed #<N>`.
  - *Refresh* (Step 2.8): update the same PR body before `gh pr ready`.
- **`/commit`** — produce logical-unit commits in conventional commit format.
- **`/push`** — push the feature branch to origin; updates the Draft PR automatically.
- **`/pull`** — rebase or merge the PR base branch into the head branch. Used by the `/land` skill's branch-freshness step.
- **`/land`** — execute the Land workflow: pre-flight checks → squash merge → post-merge bookkeeping → transition to `Done`. Triggered by Step 4.

## 12. `.codex/skills/land/SKILL.md`

```md
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
```

## 13. Implementation follow-ups (not in this spec, surfaced for the plan)

These items are *known unknowns* uncovered while drafting this spec. The implementation plan must resolve each before the new WORKFLOW.md can be shipped.

1. **`/gh-pr-writeup` skill** — does not yet exist at `.codex/skills/gh-pr-writeup/`. Needs *Initial Draft* and *Refresh* modes (see §11).
2. **`/gh-project` skill** — does not yet exist at `.codex/skills/gh-project/`. Needs to support transitions to `Land` and `Done` on the Moncher Stack project. Verify ProjectV2 API field IDs for the new project (`PVTSSF_lAHOAPiKdM4BYPVDzhTWkPc` with options including `Land` id `161b1b30`).
3. **`/commit`, `/push`, `/pull` skills** — also missing locally. Borrow from fleabucket-v2 with light adaptation.
4. **Dispatcher with `Land` in `active_states`** — verify `OrchestratorService` dispatches `Land`-state issues identically to `Ready`/`In progress`. Spot-check `packages/orchestrator/src/dispatch.ts` and `packages/orchestrator/src/service.ts`. Expected: no code change needed because the dispatch loop reads `active_states` from config.
5. **Worker `{{issue.state}}` routing** — confirm the worker's prompt rendering exposes the `Land` state value so Step 0 routing works. Spot-check `packages/worker/src/execution-phase.ts` and how the workflow lifecycle's phase mapping handles a new state value not currently in `WorkflowExecutionPhase` enum.
6. **PR-card status events** — Step 3 defensive merge handling assumes a PR-card merge *might* re-dispatch the worker. Verify behavior in `packages/tracker-github/src/orchestrator-adapter.ts`. If PR-card events are not dispatched at all, Step 3 is effectively dead code and can be slimmed further.
7. **Migration of in-flight issues** — out of scope for this spec but needed before flipping the project ID. Either drain the old project to `Done`/`Backlog` first, or add a one-time migration note.
8. **`e2e/seed/WORKFLOW.md`** — keep the existing 5-state stub for E2E tests (`Backlog`/`Ready`/`In Progress`/`Done`/`Cancelled`). Adding `Land` to E2E fixtures would require updating the stub worker and is deferred.

## 14. Risks & rollback

- **Risk:** The new `Land` state is unknown to existing code paths (e.g. `WorkflowExecutionPhase` enum, lifecycle parser). If not handled, the worker may treat `Land`-state issues as "Other → blocker comment + exit" per Step 0.
  - *Mitigation:* Implementation follow-ups #4 and #5 specifically check this. Add a `Land` execution phase if needed.
- **Risk:** Switching `project_id` mid-flight orphans any open issues on the old board. They will not be picked up by future polls.
  - *Mitigation:* Drain or migrate before flipping (follow-up #7).
- **Risk:** Draft PR upfront pattern (Step 1) means every Ready pickup creates a PR — louder noise for trivial issues that get triaged back to Backlog.
  - *Mitigation:* Step 1.2 returns to `Backlog` *before* PR creation in the triage-failure path. Only actionable issues reach Step 1.4.
- **Rollback:** WORKFLOW.md is a single file; `git revert` of the change commit restores the prior project + 5-state workflow. The `.codex/skills/land/SKILL.md` is additive and harmless if WORKFLOW.md never invokes Step 4.

## 15. Spec deltas from fleabucket-v2 (explicit divergences)

- **No `[spec]` vs `impl` issue-type branching.** github-symphony has only implementation issues. Removed Spec Start, Spec Execution, and Spec Land steps.
- **No OpenSpec.** Removed all OpenSpec sync, change archive, and feature-spec references.
- **No Evidence Browser / `test-evidence` gate.** Replaced with the existing changeset policy and the Docker E2E note pointing at `AGENT_TEST.md`.
- **No Korean enforcement (Posture 14 in fleabucket).** Kept the existing report-language detection-from-issue-body model (Posture 4).
- **No turbo.** Build/test commands are `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build` per [CLAUDE.md](../../../CLAUDE.md).
- **Single canonical workflow file.** No separate `Out of Scope` top-level section; out-of-scope items live in the workpad `위임` section and the PR body's 머지 후/사람 확인 section.
- **Land failure handling differs.** fleabucket auto-parks Land failures; github-symphony leaves them visible in `Land` (rationale: Land failures are merge-policy issues, not code-blockers).

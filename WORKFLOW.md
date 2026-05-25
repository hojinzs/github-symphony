---
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
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
hooks:
  after_create: null
  before_run: null
  after_run: null
  before_remove: null
  timeout_ms: 60000
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 10000
  max_turns: 20
codex:
  command: codex app-server
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
  stall_timeout_ms: 900000
---

## Status Map

| Status | Role | Agent Action |
| ------ | ---- | ------------ |
| **Backlog** | wait | Agent ignores. Exit quietly without commenting. Also the parking lane for code-blocked issues — agent moves the issue here with a `⛔ Blocker` comment when a blocker is hit; human resolves and moves back to `Ready`. |
| **Ready** | active | Triage scope and clarity. If a linked PR exists with unresolved review feedback, treat as a **rework re-entry** (see *Ready-return rework guard* in Step 0) and open a new work cycle before any code change. |
| **In progress** | active | Implement → test → create or update PR. Each work cycle gets exactly one workpad comment; within the same cycle, update it in place. |
| **In review** | wait | Pure human-review wait. Agent does **nothing** here except: if the PR has been merged, transition to `Done`; otherwise exit. Review rework is initiated by a human moving the issue back to `Ready` (or by the human approving and moving it to `Land`). |
| **Land** | active | The human has approved the PR. Run `/land` skill: pre-flight checks (approval, CI, branch freshness) → squash merge → post-merge actions → transition to `Done`. |
| **Done** | terminal | Completed. Agent exits immediately. |

## Agent Instructions

You are an AI coding agent working on issue {{issue.identifier}}: "{{issue.title}}".

**Repository:** {{issue.repository}}
**Current state:** {{issue.state}}

> Temporary compatibility note: this workflow intentionally avoids `pull_request_context` template variables so older installed `gh-symphony` daemons can render prompts until the runtime is upgraded.

### Task

{{issue.description}}

### Default Posture

1. This is an unattended orchestration session. Do not ask humans for follow-up actions.
2. **Blocker = code-blocking only.** A blocker is something that prevents the *code change itself* from being completed (missing required secret, unrecoverable test-infra failure, contradictory requirements that need a human decision). Review feedback, deploy concerns, and UI polish are **not** blockers. On a code-blocker: post a `⛔ Blocker` issue comment (what · why · how to unblock), transition Status → `Backlog` via `/gh-project`, then exit. Never leave a blocked issue in `In progress` with a draft PR.
3. In your final message, report only what was completed and any blockers. Do not include "next steps".
4. **Report language**: detect from the issue body and apply consistently to workpad, progress/blocker/transition comments, and PR review replies. If the language is unclear or mixed, default to English. Keep code, commands, identifiers, and raw tool output in their original form when translating reports.
5. **Log every status transition publicly** in *two* places, before or in the same operation as the board update:
   - A standalone issue comment (`gh issue comment --body-file`), formatted:
     ```
     🔁 Status: `FROM` → `TO`

     Reason: <why now>
     Cycle: <N> open|close
     ```
   - One append-only line in the current workpad's `### Status Transitions` section, newest last:
     ```
     - <ISO-8601 UTC ts> · `<FROM>` → `<TO>` · <reason> (cycle <N> open|close)
     ```
   Reason = *why this transition now*, not a restatement of the target state ("리뷰 blocking 2건 rework", not "moved to In progress").
6. Treat Issue cards as the canonical project item for planning, workpad lifecycle, and state transitions. The PR card supplies PR context only. If an issue has an open PR, inspect it from the issue timeline before deciding whether to create a new branch.
7. If the issue re-enters `Ready`, `In progress`, or `Land` while a PR already exists, treat that as a **new work cycle**: run the relevant guard (Step 0 *Ready-return rework guard* for `Ready`; the `/land` skill's pre-flight for `Land`) and create a **new workpad comment** for the cycle before any code change. Within the same cycle, always update the existing workpad in place — never create a second workpad comment.
8. Use the `/gh-project` skill for all project-board status transitions and field updates. Do not call ProjectV2 GraphQL APIs directly when this skill applies.
9. **Multi-line GitHub comments**: never pass escaped `\n` strings as `--body`. Write the body to a temporary markdown file and post with `gh ... --body-file <file>`. This applies to issue comments, PR comments, and review replies — including the standalone transition comment in Posture 5.
10. Do not edit the issue body for planning or progress tracking.
11. If you discover out-of-scope improvements during the work, open a separate issue rather than expanding the current scope.

### Workflow

#### Step 0: Determine current state and route

1. Read `{{issue.state}}` and detect the report language from the issue body before writing any human-facing text.
2. Route by state:
   - `Backlog` → Exit quietly without commenting.
   - `Ready` → run the **Ready-return rework guard** below, then proceed to Step 1 (or to Step 2 if the guard re-classifies as rework).
   - `In progress` → run the **stalled-handoff safety net** below, then proceed to Step 2.
   - `In review` → proceed to Step 3.
   - `Land` → proceed to Step 4.
   - `Done` → Exit immediately without commenting.
   - Any other state → leave a short blocker comment in the report language explaining the state is unsupported, then exit.

##### Ready-return rework guard

When entering `Ready`, before treating it as a fresh pickup, board drift, or resume, inspect linked PR state:

1. Find linked/open PRs from the issue/project item, the current workpad, and `gh pr list --search "<issue-number>"`.
2. For each linked/open PR, read `reviewDecision`, latest human reviews, inline review comments (`gh api repos/<owner>/<repo>/pulls/<N>/comments --paginate`), top-level PR comments, and recent issue comments.
3. If any linked/open PR has `CHANGES_REQUESTED`, unresolved actionable review comments, or a human instruction indicating rework, this `Ready` state means **review rework return** — not a fresh pickup and not drift.
4. For rework return: open a new work cycle (new `## Workpad` comment), post the standalone `🔁 Status:` comment, transition `Ready` → `In progress` via `/gh-project`, then proceed to Step 2 and execute the PR Feedback Sweep (see Step 2). Do not transition back to `In review` until feedback is addressed, the Completion Bar (Step 2.6) passes again, every inline comment has a reply, and re-review is requested.
5. Otherwise (no actionable feedback on any linked PR): proceed to Step 1 normally as a fresh pickup or resume.

##### Stalled-handoff safety net

When entering `In progress`, before continuing implementation, check: if the agent-verifiable Completion Bar (Step 2.6) is already met, the PR is still a **Draft**, and there is no open `⛔ Blocker` comment, then the previous turn missed the handoff. Run Step 2.8 (changeset → PR ready / refresh body → status comment → transition to `In review`) immediately this turn — do not look for more Plan work. This rescues an issue that would otherwise sit stalled on the next polling tick.

#### Step 1: Ready triage

This step is entered only when the Step 0 *Ready-return rework guard* classified the entry as **fresh pickup or resume**. Rework returns are routed directly to Step 2 by the guard.

1. Read the issue body and existing comments to understand the requested work.
2. **Triage actionability:**
   - **Requirements unclear** → write a triage comment in the report language requesting clarification, post the `🔁 Status: Ready → Backlog` transition log (Posture 5), transition via `/gh-project`, exit.
   - **Scope too large** (likely >20 files or >3 packages) → write a triage comment requesting issue splitting, post the transition log, transition to `Backlog`, exit. State explicitly whether the reason is unclear requirements, oversized scope, or both.
3. **Resume check (idempotent).** If a `feat/<issue-number>-…` branch or Draft PR for this issue already exists from a prior cycle (e.g. parked in `Backlog` then moved back), adopt them — do **not** recreate.
4. **Open the new work cycle:**
   - Create a new `## Workpad — {{issue.identifier}} — Cycle N` comment using the Workpad Template (see *Workpad Lifecycle*). N is the next cycle number after the most recent workpad on the issue (1 if none).
   - Determine the base branch: `main` by default. If the issue body explicitly references an Epic working branch, use that; otherwise stay on `main`.
   - Create a `feat/<issue-number>-<short-description>` branch from the base branch (unless the resume check above adopted one).
   - Push the branch and create a **Draft PR** targeting the same base branch using the `/gh-pr-writeup` skill to scaffold the body (TL;DR, 변경 지점 다이어그램, 여기부터 보세요, 위험 & 롤백, 변경 파일 — finalized in Step 2.8). Include `## Issues\n- Closed #<issue-number>` so GitHub auto-links.
   - Record the Draft PR URL and base branch in the workpad.
5. Post the standalone `🔁 Status: Ready → In progress` comment (cycle N open), append the matching workpad `### Status Transitions` line, then transition via `/gh-project`.
6. Proceed to Step 2.

#### Step 2: In progress / Execution

Entered from one of:

- **Step 1** (fresh pickup / resume) — first work cycle, Draft PR already exists.
- **Step 0 *Ready-return rework guard*** (review rework) — new cycle opened by the guard, Draft PR already exists.
- **Step 0 *stalled-handoff safety net*** — skip directly to Step 2.8 this turn.

1. **Workpad continuity.** The current cycle's workpad was created by Step 1 or the rework guard. Update it in place throughout this cycle. Never create a second workpad for the same cycle.

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
   - [ ] If the change affects integration behavior (orchestrator dispatch, worker lifecycle, tracker adapters, status API, etc.), a short TC was added and a Docker E2E blackbox run completed per [AGENT_TEST.md](AGENT_TEST.md). Results recorded in the workpad `### Validation` section.
   - [ ] Tests written for new functionality (or justified N/A and noted).
   - [ ] Code follows the conventions in [CLAUDE.md](CLAUDE.md) (strict TypeScript, Prettier, conventional commits).
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

#### Step 3: In review — pure wait

This is a human-review wait state. `In review` is **not** in `active_states`, so the dispatcher does not normally wake the worker here. If the worker is invoked at this state (e.g. a PR-card merge event triggers re-dispatch, or a future poll catches a stale in-review issue whose PR was merged outside the normal flow), perform a single defensive check:

1. If the PR has been merged: refresh the merged commit SHA into the workpad, post the standalone `🔁 Status: In review → Done` comment (cycle close), append the matching workpad Status Transitions line, transition the issue to `Done` via `/gh-project`, and exit.
2. Otherwise: exit immediately. Do **not** process review feedback. Do **not** reply to inline comments. Do **not** transition the issue.

Rework feedback is initiated by a human moving the issue back to `Ready` — the Step 0 *Ready-return rework guard* then opens the rework cycle (Step 2). PR approval and the actual merge happen when a human moves the issue to `Land` — Step 4 (`/land`) performs the squash merge.

#### Step 4: Land — squash merge and complete

**Trigger:** `{{issue.state}}` = `Land`. A human has approved the PR and moved the issue here.

1. **Open the land cycle.** Create a new `## Workpad — {{issue.identifier}} — Cycle N (Land)` comment (do not reuse the prior `In progress` cycle's workpad — see *Workpad Lifecycle*). Post the standalone `🔁 Status: In review → Land` comment (cycle N open: land), append the matching workpad Status Transitions line.

2. **Invoke the `/land` skill** (defined at `.codex/skills/land/SKILL.md`). The skill is responsible for:
   - Pre-flight checks (approval, required CI checks, base-branch freshness, changeset presence if labeled — see the skill for the exact list).
   - Running `/pull` if the branch is behind, then re-running pre-flight from scratch.
   - Squash merge: `gh pr merge <pr-number> --squash --delete-branch`.
   - Recording the merged commit SHA and changeset path (if any) in the workpad.
   - Transitioning the issue to `Done` via `/gh-project` once the merge succeeds.
   - Posting the standalone `🔁 Status: Land → Done` comment ONLY after the `/gh-project` Done transition returns success.

3. **Close the land cycle.** Once `/land` completes, verify the standalone `🔁 Status: Land → Done` comment was posted and the workpad Status Transitions line was appended (cycle N close: land). If `/land` exited before this step (e.g. due to dependency-skill failure noted in `.codex/skills/land/SKILL.md` Required Context), do not retry blindly — the skill's failure handling already recorded the cause.

4. **On `/land` failure.** The skill records the failure and exits. If the same step fails 3 consecutive times for the same cause, write a `⛔ Blocker` comment, do **not** transition the issue, and exit. A human resolves the cause and either moves the issue back to `In review` (sends Step 4 home as a no-op next time) or re-enters `Land` after fixing the underlying problem.

This step performs no code edits, commits, or pushes itself — only the workpad/comment bookkeeping around the skill call. Any rework code change must come through the `In review` → `Ready` → Step 2 path.

### Guardrails

- Do not edit the issue body for planning or progress tracking.
- If the issue is in a terminal state, do nothing and exit.
- If you find out-of-scope improvements, open a separate issue rather than expanding the current scope.
- When moving an issue from `Ready` back to `Backlog`, always explain whether the reason is unclear requirements, oversized scope, or both.
- Do not start implementation for issues sent back to `Backlog` in the same run.
- When a PR exists, do not ignore inline review comments; read them all and reply to each one.
- When an issue re-enters `Ready` or `In progress` with an existing PR, do not silently resume work; inspect the main merge blockers first and create a new workpad comment that restates the plan for the new work cycle. Within that cycle, update the same workpad comment — never create a second one.
- If both an Issue and its linked PR appear in the Project, the Issue is the canonical item for planning, workpad lifecycle, and state transitions. The PR card supplies PR context only.
- Current limitation: if only the PR card status changes while the canonical Issue card does not move into an active state, the worker may not be re-dispatched from that PR card status change alone.

### Workpad Lifecycle

A **work cycle** begins when an issue transitions into an active state (`Ready` or `In progress`) from a non-active state (`Backlog`, `In review`, `Done`), or when the issue is first picked up. Each work cycle gets exactly **one** workpad comment.

- **Cycle start:** Create a new `## Workpad` comment on the issue.
- **Within the same cycle:** Always **edit (update)** the existing workpad comment. Do not create additional workpad comments.
- **How to identify the current cycle's workpad:** Find the most recent comment on the issue that starts with `## Workpad`. If it belongs to the current cycle, update it. If no workpad exists for the current cycle, create one.
- **New cycle detection:** A new cycle has started if the issue transitioned from `In review` (or another non-active state) back to `Ready` or `In progress` since the last workpad was created. In that case, create a new workpad comment rather than updating the previous cycle's workpad.

### Workpad Template

Create a workpad comment on the issue with the following structure to track progress:

```md
## Workpad

### Re-entry Context

- Trigger: initial implementation / resumed after PR feedback
- PR: URL or `none`
- Major merge blockers:
  - blocker 1
  - blocker 2

### Plan

- [ ] 1. Task item

### Acceptance Criteria

- [ ] Criterion 1

### Validation

- [ ] Test: `command`

### Notes

- Progress notes
- Scope assessment
```

### Related Skills

- `/gh-project` — interact with GitHub Project v2 board for status transitions and workpad comments
- `/gh-pr-writeup` — draft or refresh PR bodies with linked issues, validation evidence, and human validation checklists
- `/commit` — produce clean, logical commits during implementation
- `/push` — keep remote branch current and publish updates
- `/pull` — sync branch with latest origin/main before PR handoff
- `/land` — merge approved PR and transition the issue to `Done`

---
tracker:
  kind: github-project
  # 🧩 Moncher Stack (hojinzs/projects/14)
  project_id: PVT_kwHOAPiKdM4BYPVD
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

| Status          | Role     | Agent Action                                                                                                                                                                                                                                             |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backlog**     | wait     | Agent ignores. Exit quietly without commenting. Also the parking lane for code-blocked issues — agent moves the issue here with a `⛔ Blocker` comment when a blocker is hit; human resolves and moves back to `Ready`.                                  |
| **Ready**       | active   | Triage scope and clarity. If a linked PR exists with unresolved review feedback, treat as a **rework re-entry** (see _Ready-return rework guard_ in Step 0) and open a new work cycle before any code change.                                            |
| **In progress** | active   | Implement → test → create or update PR. Each work cycle gets exactly one workpad comment; within the same cycle, update it in place.                                                                                                                     |
| **In review**   | wait     | Pure human-review wait. Agent does **nothing** here except: if the PR has been merged, transition to `Done`; otherwise exit. Review rework is initiated by a human moving the issue back to `Ready` (or by the human approving and moving it to `Land`). |
| **Land**        | active   | The human has approved the PR. Run `/land` skill: pre-flight checks (approval, CI, branch freshness) → squash merge → post-merge actions → transition to `Done`.                                                                                         |
| **Done**        | terminal | Completed. Agent exits immediately.                                                                                                                                                                                                                      |

## Agent Instructions

You are an AI coding agent working on issue {{issue.identifier}}: "{{issue.title}}".

**Repository:** {{issue.repository}}
**Current state:** {{issue.state}}

> Temporary compatibility note: this workflow intentionally avoids `pull_request_context` template variables so older installed `gh-symphony` daemons can render prompts until the runtime is upgraded.

### Task

{{issue.description}}

### Default Posture

1. This is an unattended orchestration session. Do not ask humans for follow-up actions.
2. **Blocker = code-blocking only.** A blocker is something that prevents the _code change itself_ from being completed (missing required secret, unrecoverable test-infra failure, contradictory requirements that need a human decision). Review feedback, deploy concerns, and UI polish are **not** blockers. On a code-blocker: post a `⛔ Blocker` issue comment (what · why · how to unblock), transition Status → `Backlog` via `/gh-project`, then exit. Never leave a blocked issue in `In progress` with a draft PR.
3. In your final message, report only what was completed and any blockers. Do not include "next steps".
4. **Report language**: detect from the issue body and apply consistently to workpad, progress/blocker/transition comments, and PR review replies. If the language is unclear or mixed, default to English. Keep code, commands, identifiers, and raw tool output in their original form when translating reports.
5. **Log every status transition through the orchestrator-owned `/gh-project` request.** The agent supplies the policy-authored `comment_body`; the orchestrator publishes that exact body only after `ok: true` + `outcome: confirmed` + exact target-state readback. The agent must not post a duplicate standalone status-transition comment or a correction status comment with `gh issue comment`.

   Prepare the body in a temporary file and pass its contents as `comment_body`:

   ```
   🔁 Status: `FROM` → `TO`

   Reason: <why now>
   Cycle: <N> open|close
   ```

   Reason = _why this transition now_, not a restatement of the target state ("review blocking 2 items rework", not "moved to In progress"). Keep the exact body and intended workpad line in the current workpad before requesting the transition. After a confirmed readback, append the matching line to `### Status Transitions` if the worker remains alive.

   If the response is not `ok: true` + `outcome: confirmed` + the requested target state, no status comment was published. Record the returned state/error and the failed transition in the workpad, then follow the failure handling for the current step. Do not publish a correction status comment.

   **Lifecycle finalization order.** Treat a Project status transition as the final lifecycle mutation for the turn, not as a progress signal. Before requesting it, complete the scoped implementation/rebase/merge decision, collect final validation output, refresh the PR/workpad narrative, and record the transition reason, exact `comment_body`, and evidence in the workpad's Validation/Progress Log sections. Then request the state transition. The only permitted work after the request is recording a failed response if the worker remains alive; the orchestrator owns the public transition comment.

6. Treat Issue cards as the canonical project item for planning, workpad lifecycle, and state transitions. The PR card supplies PR context only. If an issue has an open PR, inspect it from the issue timeline before deciding whether to create a new branch.
7. If the issue re-enters `Ready`, `In progress`, or `Land` while a PR already exists, treat that as a **new work cycle**: run the relevant guard (Step 0 _Ready-return rework guard_ for `Ready`; the `/land` skill's pre-flight for `Land`) and create a **new workpad comment** for the cycle before any code change. Within the same cycle, always update the existing workpad in place — never create a second workpad comment.
8. Use the `/gh-project` skill for all tracker status reads and transitions. Workers send intent to the run-scoped orchestrator API and never traverse provider boards or mutate tracker fields directly.
9. **Multi-line GitHub comments**: never pass escaped `\n` strings as `--body`. Write the body to a temporary markdown file and post with `gh ... --body-file <file>`. This applies to workpad comments, triage/blocker comments, PR comments, and review replies. Status-transition bodies are supplied as `/gh-project` `comment_body`; do not post them directly.
10. Do not edit the issue body for planning or progress tracking.
11. If you discover out-of-scope improvements during the work, open a separate issue rather than expanding the current scope.
12. **Merged-PR invariant.** A linked PR in `MERGED` state always takes precedence over pickup, rework, pre-flight, and failure classification. Transition the canonical Issue directly to `Done` and exit. A merged issue must never transition to `Ready`.

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

1. Find linked PRs in every state from the issue/project item, the current workpad, and `gh pr list --state all --search "<issue-number>"`.
2. **Merged-PR precedence guard:** if any linked PR is `MERGED`, refresh its merged commit SHA into the current workpad when one exists, prepare the `🔁 Status: Ready → Done` body, and send it as `comment_body` through `/gh-project`. After confirmed readback, append the matching workpad Status Transitions line when the worker remains alive, then exit. Do not open a new cycle, inspect review feedback, check out the deleted head branch, or enter any rework path.
3. For each remaining open linked PR, read `reviewDecision`, latest human reviews, inline review comments (`gh api repos/<owner>/<repo>/pulls/<N>/comments --paginate`), top-level PR comments, and recent issue comments.
4. If any open linked PR has `CHANGES_REQUESTED`, unresolved actionable review comments, a human instruction indicating rework, or a recent `Land` → `Ready` transition recorded as a **Land-return rework**, this `Ready` state means **review rework return** — not a fresh pickup and not drift.
5. For rework return: open a new work cycle (new `## Workpad` comment), prepare the `🔁 Status: Ready → In progress` body, and pass it as `comment_body` through `/gh-project`. Append the matching workpad line only after confirmed readback, then proceed to Step 2 and execute the rework preamble (Step 2.2). Do not transition back to `In review` until feedback is addressed, the Completion Bar (Step 2.6) passes again, every inline comment has a reply, and re-review is requested.
6. Otherwise (no actionable feedback or Land-return rework marker on any linked PR): proceed to Step 1 normally as a fresh pickup or resume.

##### Stalled-handoff safety net

When entering `In progress`, before continuing implementation, check: if the agent-verifiable Completion Bar (Step 2.6) is already met, the PR is still a **Draft**, and there is no open `⛔ Blocker` comment, then the previous turn missed the handoff. Run Step 2.8 (changeset → PR ready / refresh body → status comment → transition to `In review`) immediately this turn — do not look for more Plan work. This rescues an issue that would otherwise sit stalled on the next polling tick.

#### Step 1: Ready triage

This step is entered only when the Step 0 _Ready-return rework guard_ classified the entry as **fresh pickup or resume**. Rework returns are routed directly to Step 2 by the guard.

1. Read the issue body and existing comments to understand the requested work.
2. **Triage actionability:**
   - **Requirements unclear** → write a triage comment in the report language requesting clarification, prepare the `🔁 Status: Ready → Backlog` body with `Cycle: — (triage rejection)`, and send it as `comment_body` through `/gh-project`, then exit.
   - **Scope too large** (likely >20 files or >3 packages) → write a triage comment requesting issue splitting, prepare the transition body, and send it as `comment_body` through `/gh-project`. State explicitly whether the reason is unclear requirements, oversized scope, or both.
3. **Resume check (idempotent).** If a `feat/<issue-number>-…` branch or Draft PR for this issue already exists from a prior cycle (e.g. parked in `Backlog` then moved back), adopt them — do **not** recreate.
4. **Open the new work cycle:**
   - Create a new `## Workpad — {{issue.identifier}} — Cycle N` comment using the Workpad Template (see _Workpad Lifecycle_). N is the next cycle number after the most recent workpad on the issue (1 if none).
   - Determine the base branch: `main` by default. If the issue body explicitly references an Epic working branch, use that; otherwise stay on `main`.
   - Create a `feat/<issue-number>-<short-description>` branch from the base branch (unless the resume check above adopted one).
   - Push the branch and create a **Draft PR** targeting the same base branch using the `/gh-pr-writeup` skill to scaffold the body (TL;DR, change-point diagram, start-here guide, risks & rollback, changed files — finalized in Step 2.8). Include `## Issues — Closed #<issue-number>` so GitHub auto-links.
   - Record the Draft PR URL and base branch in the workpad.
5. Prepare the `🔁 Status: Ready → In progress` body, pass it as `comment_body` to `/gh-project`, and append the matching workpad `### Status Transitions` line only after confirmed readback. If the request does not return confirmed readback for `In progress`, record the failure and stop without publishing a status comment.
6. Proceed to Step 2.

#### Step 2: In progress / Execution

Entered from one of:

- **Step 1** (fresh pickup / resume) — first work cycle, Draft PR already exists.
- **Step 0 _Ready-return rework guard_** (review rework) — new cycle opened by the guard, Draft PR already exists.
- **Step 0 _stalled-handoff safety net_** — skip directly to Step 2.8 this turn.

1. **Workpad continuity.** The current cycle's workpad was created by Step 1 or the rework guard. Update it in place throughout this cycle. Never create a second workpad for the same cycle.

2. **Rework preamble — only when entered via rework return.** Before any code change:
   - Read all PR review activity: latest reviews, top-level PR comments, inline review comments (`gh api repos/<owner>/<repo>/pulls/<N>/comments --paginate`), failing checks.
   - Distill the main merge blockers into a prioritized list and record them in the workpad `### Rework / PR Feedback` section with the revised plan.
   - As you address each inline comment, reply to it in the report language with a concrete resolution summary or rationale. Never leave an inline comment unanswered.

3. **Implementation — one Plan item per turn.** Explore relevant code, implement, write/update tests, commit in logical units (conventional commit format). Push to the branch after each turn — the Draft PR auto-updates.

4. **Turn-end checklist.** Before ending a turn:
   - workpad Plan item marked `[x]` and a Progress Log entry added.
   - For a lifecycle handoff, merge outcome, or failure classification: all final evidence, exact reason, intended next action, and transition `comment_body` are already recorded in the workpad before requesting the Project state transition. Only recording the confirmed response/workpad line is deferred.
   - Any confirmed status transition this turn is logged by the orchestrator's exact `comment_body` publication plus the workpad Status Transitions line when the worker remains alive.
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
   1. Run `/gh-pr-writeup` to refresh the PR body so TL;DR · change-point diagram · start-here guide · risks & rollback · changed files · `## Issues — Closed #<N>` · post-merge/human validation sections are current.
   2. Complete the current workpad's Completion Bar, final Validation results, and Progress Log entry, including the exact handoff reason, before its lifecycle transition.
   3. Mark the Draft PR ready: `gh pr ready <pr-number>`.
   4. Prepare the `🔁 Status: In progress → In review` body and include it as `comment_body` in the `/gh-project` request.
   5. Transition the issue to `In review` via `/gh-project` as the last action of the turn. The orchestrator publishes the body after confirmed exact-item readback; if the request fails, record the failure and keep the cycle open.

   **Never end a turn with the Completion Bar met and the PR still Draft.** That state deadlocks the workflow (Step 3 only fires on merge; the worker won't be re-dispatched). The Step 0 stalled-handoff safety net rescues it on the next polling tick as a backstop, but it should not be needed.

#### Step 3: In review — pure wait

This is a human-review wait state. `In review` is **not** in `active_states`, so the dispatcher does not normally wake the worker here. If the worker is invoked at this state (e.g. a PR-card merge event triggers re-dispatch, or a future poll catches a stale in-review issue whose PR was merged outside the normal flow), perform a single defensive check:

1. If the PR has been merged: refresh the merged commit SHA into the workpad, prepare the `🔁 Status: In review → Done` body, and send it as `comment_body` through `/gh-project`. After confirmed readback, append the matching workpad Status Transitions line when the worker remains alive, then exit.
2. Otherwise: exit immediately. Do **not** process review feedback. Do **not** reply to inline comments. Do **not** transition the issue.

Rework feedback is initiated by a human moving the issue back to `Ready` — the Step 0 _Ready-return rework guard_ then opens the rework cycle (Step 2). PR approval and the actual merge happen when a human moves the issue to `Land` — Step 4 (`/land`) performs the squash merge.

#### Step 4: Land — squash merge and complete

**Trigger:** `{{issue.state}}` = `Land`. A human has approved the PR and moved the issue here.

1. **Open the land cycle.** Create a new `## Workpad — {{issue.identifier}} — Cycle N (Land)` comment (do not reuse the prior `In progress` cycle's workpad — see _Workpad Lifecycle_). The human-owned `In review` → `Land` transition has already been confirmed before this worker is dispatched; record it as the cycle trigger, but do not replay it through `/gh-project` or publish a duplicate status comment. All agent-owned transitions in this cycle (including `Land` → `Done` and classified exits) must carry their policy-authored body as `comment_body` through `/gh-project`.

2. **Invoke the `/land` skill** (defined at `.codex/skills/land/SKILL.md`). The skill is responsible for:
   - Running the **merged-PR precedence guard before any pre-flight check**: if the linked PR is already `MERGED`, skip branch freshness, mergeability, review, and failure classification; record the merged commit SHA and transition `Land` → `Done` through `/gh-project`, then exit.
   - Pre-flight checks (approval, required CI checks, base-branch freshness, changeset presence if labeled — see the skill for the exact list).
   - Running `/pull` if the branch is behind, then re-running pre-flight from scratch.
   - Squash merge: `gh pr merge <pr-number> --squash --delete-branch`.
   - Recording the merged commit SHA and changeset path (if any) in the workpad.
   - Supplying the `🔁 Status: Land → Done` body as `comment_body` to `/gh-project`; the orchestrator publishes it after confirmed readback and the worker records the matching workpad line if it remains alive.
   - Transitioning the issue to `Done` via `/gh-project` afterwards, as the last action of the turn (Posture 5 ordering).

3. **Close the land cycle.** Once `/land` completes, verify the orchestrator confirmed the `Land → Done` request and the workpad Status Transitions line was appended (cycle N close: land) if the worker remains alive. If `/land` exited before this step (e.g. due to dependency-skill failure noted in `.codex/skills/land/SKILL.md` Required Context), do not retry blindly — the skill's failure handling already recorded the cause.

4. **On `/land` failure or wait.** The skill records the final evidence before any lifecycle transition, classifies it, and exits without merging only when it cannot safely complete the Land cycle:
   - **Merged-PR precedence guard (always first)** — before applying any classification below, re-read the linked PR state. If it is `MERGED`, record the merged commit SHA, prepare the `🔁 Status: Land → Done` body, and transition through `/gh-project`, then exit. Never classify a merged PR as rework or transition it to `Ready`, even when its deleted head branch makes freshness or mergeability checks fail.
   - **Required CI pending or registering** — keep the issue in `Land` and wait in the current Land turn. This includes checks re-queued because `/pull` refreshed the branch. Only required checks gate this path: before `/pull`, record the required-check names returned by `gh pr checks <pr-number> --required --json name,bucket`. If that result is empty, no required CI is configured and this gate passes without a registration wait. Otherwise, poll every 10 seconds until those previously observed required checks appear on the fresh head, then use `gh pr checks <pr-number> --required --watch --interval 10` until it reaches a terminal state. Do not invoke `--watch` while no check suite is registered, because it exits immediately instead of waiting for a future suite. Limit check-registration polling to 5 minutes; if the expected required checks do not appear, record the new head SHA and polling evidence, then classify it as the external wait-only failure below. Do not treat a newly-running required check as a `Land` → `In review` failure. Once CI reaches a terminal state, re-run the **entire** Land pre-flight (approval, checks, freshness, changeset, mergeability, and review feedback): merge if it passes; otherwise classify the resulting concrete failure below.
   - **Approval or other external wait-only failure** — no human `APPROVED` review or another condition awaiting human/external review after CI is terminal: complete the workpad evidence, prepare a status body stating the concrete pre-flight finding (which gate failed, on which head SHA, and what a human must do), and send it as `comment_body` while transitioning `Land` → `In review` via `/gh-project`. Do **not** write a `⛔ Blocker` comment.
   - **Rework failure** — failed required CI, merge conflict, missing labeled Changeset, unresolved actionable review feedback, or another PR/code condition that the worker can address: prepare a status body with reason `Land-return rework: <cause>`, then transition `Land` → `Ready` via `/gh-project` with that body. The Ready-return rework guard opens the next cycle and routes it to `In progress`.
   - **External or permission blocker** — missing required context, authentication/board failure, or an external dependency the worker cannot resolve: write a `⛔ Blocker` comment, prepare a status body stating the unblock condition, then transition `Land` → `Backlog` via `/gh-project` with that body.
   - **Immediately recoverable branch freshness** — when the branch is behind, run `/pull` and re-run the complete pre-flight sequence. Keep `Land` only for this in-run recovery path; if `/pull` fails, classify the failure using the rules above.

This step performs no code edits, commits, or pushes itself — only the workpad/comment bookkeeping around the skill call. Any rework code change must come through the `Land` → `Ready` → `In progress` path.

### Guardrails

- Write everything you publish — PR titles and bodies, commit messages, workpad comments, status transition comments, and any new issues — in English, regardless of the language the issue was written in.
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

A **work cycle** is one continuous active stretch on an issue. It opens when the issue enters an active state from a wait/terminal state, and closes when it returns to a wait/terminal state. Turns are sub-units inside a cycle.

| Transition                                                            | Cycle effect                              |
| --------------------------------------------------------------------- | ----------------------------------------- |
| (any wait state) → `Ready` → `In progress`                            | open **cycle N** (fresh pickup or resume) |
| `In progress` → `In review`                                           | close current cycle (handoff to human)    |
| `In review` → `Ready` → `In progress` (via Ready-return rework guard) | open **next cycle** (rework)              |
| `In progress` → `Backlog` (code-blocker)                              | close current cycle (parked)              |
| `Backlog` → `Ready` (resume after blocker resolved)                   | open **next cycle** (resume)              |
| `In review` → `Land`                                                  | open a **land cycle**                     |
| `Land` → `Done`                                                       | close the land cycle (terminal)           |

**Rules:**

- Each cycle gets exactly **one** `## Workpad — {{issue.identifier}} — Cycle N` comment.
- Within a cycle, **edit** the existing workpad in place. Never create a second workpad for the same cycle.
- When a new cycle opens, create a **new** workpad comment. Prior cycle workpads remain as historical audit records — do not silently rewrite them.
- The "current" workpad is the newest open cycle comment. Identify it by searching for the most recent comment whose body starts with `## Workpad —`.
- Cycle number N increments across the whole issue lifetime — including land cycles. (Example: cycle 1 initial work, cycle 2 rework, cycle 3 land.) Cycles open on a transition into `In progress` (Step 1.5 / Step 0 Ready-return guard step 4) or `Land` (Step 4.1); transitions into intermediate active states like `Ready` do not open a cycle.
- Triage failures (`Ready` → `Backlog` from Step 1.2) do **not** open or close a cycle. The `comment_body` still identifies the transition, but the `Cycle:` line is written as `Cycle: — (triage rejection)`. The next cycle number is unaffected.

### Status Transition Log

(See Posture 5 for the orchestrator-owned publication rule.) For every requested lifecycle transition, the agent prepares this exact body and sends it as `/gh-project` `comment_body`:

```md
🔁 Status: `FROM` → `TO`

Reason: <why now>
Cycle: <N> open|close
```

After confirmed readback, the orchestrator publishes the body exactly once (or reports `unchanged` when the exact body already exists). The agent appends one matching line to the current workpad's `### Status Transitions` section if it remains alive:

```md
- <ISO-8601 UTC ts> · `<FROM>` → `<TO>` · <reason> (cycle <N> open|close)
```

On a failed request, no status comment is published; record the returned state/error and a failure line in the workpad. `reason` is _why this transition now_ — not a restatement of `TO`.

### Workpad Template

Used for all cycles. Land-cycle workpads keep Plan/Validation/Progress Log filled and leave Completion Bar / Rework empty.

```md
## Workpad — {{issue.identifier}} — Cycle {N}

**Type:** {fresh pickup | rework cycle (PR #X) | resume after blocker | land}
**Branch:** {branch name}
**Draft PR:** {PR URL or `not yet created`}
**Cycle opened:** {ISO ts} · **Trigger:** {one-line reason}

### Status Transitions

<!-- append-only within this cycle; the orchestrator publishes the exact
     comment_body after confirmed readback -->

- {ISO ts} · `{FROM}` → `{TO}` · {why now} (cycle {N} open|close)

### Plan

<!-- one item per turn (Step 2.3). LAST item is always the handoff.
     Out-of-scope items go under Delegation below, never here. -->

- [ ] 1. {task item}
- [ ] N. Wrap-up: re-verify the original issue · pass the Completion Bar · changeset (if needed) · PR ready · transition to In review

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

### Delegation (out-of-scope / human / post-merge)

<!-- items from {{issue.description}} that the agent does NOT do: deploy,
     external URL smoke test, manual UX. Mirror into the PR body's
     post-merge/human validation section. NOT blockers, NOT Plan checkboxes. -->

- {none | item}

### Progress Log

- {ISO ts}: {action taken}

### Blockers

<!-- code-blockers only (Posture 2). On a code-blocker: write ⛔ here + as a
     standalone issue comment, then park Status → Backlog. -->

None
```

### Related Skills

All skills referenced by this workflow live under `.codex/skills/<name>/SKILL.md` so the codex-driven worker can discover them.

- **`/gh-project`** — request run-scoped state reads/transitions from the orchestrator. The orchestrator owns canonical item identity, provider quota, mutation, retry/backoff, and exact-item readback; comments/workpad updates follow confirmed success only (Posture 8).
- **`/gh-pr-writeup`** — scaffold or refresh the PR body. Two modes:
  - _Initial Draft_ (Step 1): create a new Draft PR with TL;DR · change-point diagram · start-here guide · risks & rollback · changed files · `## Issues — Closed #<N>` · post-merge/human validation placeholders.
  - _Refresh_ (Step 2.8): update the same PR body before `gh pr ready`.
- **`/commit`** — produce logical-unit commits in conventional commit format.
- **`/push`** — push the feature branch to origin; updates the Draft PR automatically.
- **`/pull`** — rebase or merge the PR base branch into the head branch. Used by the `/land` skill's branch-freshness step.
- **`/land`** — execute the Land workflow: pre-flight checks → squash merge → post-merge bookkeeping → transition to `Done`. Triggered by Step 4.

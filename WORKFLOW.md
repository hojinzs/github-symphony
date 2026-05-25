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

1. Read the current issue state before doing any implementation work.
2. Detect the report language from the issue body before writing any human-facing text.
3. Route by state:
   - `Backlog` -> Exit quietly without commenting.
   - `Ready` -> Proceed to Step 1.
   - `In progress` -> Proceed to Step 2.
   - `In review` -> Proceed to Step 3.
   - `Done` -> Exit immediately without commenting.
   - Any other state -> Leave a short blocker comment in the report language explaining that the state is unsupported, then exit.

#### Step 1: Ready triage

1. Read the issue body and existing comments to understand the requested work.
2. Assess whether the issue is actionable before creating or updating a workpad.
3. If the requirements are unclear, move the issue back to `Backlog`, leave a comment in the report language requesting clearer requirements, and exit.
4. If the expected implementation is too large in scope, move the issue back to `Backlog`, leave a comment in the report language requesting issue splitting, and exit.
5. Treat the issue as too large in scope if it would likely require changes to more than 20 files or more than 3 packages.
6. If the issue is actionable and a PR already exists, inspect the PR review timeline, failing checks, and unresolved comments to identify the major merge blockers before touching the code.
7. If Step 6 applies, this is a new work cycle — create a new workpad comment in the report language that records the re-entry trigger, the major merge blockers, and the revised implementation plan.
8. If the issue is actionable and Step 7 did not apply, create or continue the workpad, create a branch if needed, post a comment indicating that triage passed and implementation is starting, and continue to Step 2. If an existing PR is discovered from the issue timeline, prefer checking out and updating that PR head branch instead of creating a duplicate branch.

#### Step 2: Execution phase

1. Check whether the current work cycle's workpad comment already exists on the issue. If it does, update it in place throughout this run. If this is a new work cycle (issue re-entered an active state from `In review` or a wait state) and no workpad has been created for it yet, create a new workpad comment after identifying the latest merge blockers. Never create a second workpad comment within the same work cycle.
2. Explore the codebase to understand the relevant code structure.
3. Implement the changes following the project's coding conventions.
4. Write or update tests to cover the changes.
5. Verify that all existing tests pass before creating or updating a PR.
6. **Pre-review validation (mandatory before moving to `In review`):**
   - Re-read the original issue body and compare it against the implementation to confirm that every requested item has been addressed and nothing was missed or diverged from the goal.
   - If any requirement is unmet or the implementation deviates from the issue's intent, fix it before proceeding.
   - Run `pnpm lint && pnpm test && pnpm typecheck && pnpm build` and confirm all pass.
   - If the change affects integration behavior (orchestrator dispatch, worker lifecycle, tracker adapters, status API, etc.), write a short TC and run a Docker E2E blackbox test following [AGENT_TEST.md](AGENT_TEST.md).
   - Record the validation results (commands executed and their outcomes) in the workpad comment under the **Validation** section.
7. **Changeset policy (mandatory immediately before PR creation/update):**
   - Inspect the issue labels. If the issue has one of `changeset:major`, `changeset:minor`, or `changeset:patch`, create a Changeset before creating or updating the PR.
   - The release package must be `@gh-symphony/cli` only. Do not add private/internal workspace packages to the Changeset because releases publish only the CLI package.
   - Use the label as the bump type: `changeset:major` -> major, `changeset:minor` -> minor, `changeset:patch` -> patch. If multiple changeset labels exist, use the highest-impact bump (`major` > `minor` > `patch`) and note the ambiguity in the workpad.
   - The Changeset summary must describe the user-visible CLI/runtime behavior change and reference the issue identifier when practical.
   - Record the created Changeset file path in the workpad **Validation** section.
8. If no PR exists and the completion bar is met, use the `/gh-pr-writeup` skill to run a brief pre-PR validation pass, create a PR with the required linked-issue, evidence, and human validation sections, post a comment summarizing what was implemented, and move the issue to `In review`.
9. If a PR already exists while the issue is `In progress`, read all PR review activity, failing checks, and unresolved inline comments before changing any code.
10. Distill the main merge blockers into a short prioritized list, then update the current cycle's workpad comment in the report language to capture those blockers and the revised execution plan. If no workpad exists for this cycle yet, create one.
11. Reply to each inline review comment in the report language with a concrete resolution summary or rationale once you have addressed or triaged it.
12. If review feedback requires code changes, implement them, update tests if needed, re-run the pre-review validation in Step 6, push the changes, refresh the PR body with `/gh-pr-writeup` so the linked issue, evidence, and human validation sections stay current, post a comment describing what was addressed, and move the issue back to `In review`.
13. If the current subject is `PullRequest`, perform all rework on the PR head branch and keep the PR as the primary review surface.

#### Step 3: In review handling

1. If a PR exists, inspect review state, review comments, and inline comments.
2. If the PR is merged, post a comment confirming completion, move the issue to `Done`, and exit.
3. If there are no change requests and no actionable unresolved inline comments, remain in `In review` and exit.
4. If review feedback requires code changes, identify the major merge blockers, post a comment listing the required changes, move the issue to `In progress`, and proceed to Step 2 — this starts a new work cycle, so create a new workpad comment before editing code.
5. If reviewers left inline comments that only need answers, reply to each inline comment in the report language and remain in `In review`.

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

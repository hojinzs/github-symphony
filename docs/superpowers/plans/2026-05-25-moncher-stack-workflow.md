# Moncher Stack Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update [`WORKFLOW.md`](../../../WORKFLOW.md) to point at the user-level "🧩 Moncher Stack" project (`PVT_kwHOAPiKdM4BYPVD`) and adopt the fleabucket-v2 *Land*-state workflow model, and create `.codex/skills/land/SKILL.md` so the codex-driven worker can execute the merge step.

**Architecture:** Document-first rewrite. `WORKFLOW.md` is YAML-frontmatter + Markdown that the worker renders into the agent prompt. `.codex/skills/land/SKILL.md` is a markdown skill the codex runtime discovers at run time. The orchestrator (TypeScript) parses the frontmatter; pre-verification (Task 1) proves the existing code already handles `Land` in `active_states` correctly.

**Tech Stack:** Markdown (WORKFLOW.md, SKILL.md), TypeScript (`packages/core` — verification test only), Vitest 1.x, `pnpm` (no turbo), `gh` CLI.

**Spec:** [`docs/superpowers/specs/2026-05-25-moncher-stack-workflow-design.md`](../specs/2026-05-25-moncher-stack-workflow-design.md). Section numbers in this plan (e.g. *Spec §3*) refer to that spec.

---

## File Structure

Files created or modified by this plan:

- **Create:** `.codex/skills/land/SKILL.md` — the `/land` skill content per *Spec §12*. Self-contained markdown; no code dependencies.
- **Modify:** `WORKFLOW.md` (single file, ~190 lines → ~280 lines) — full rewrite per *Spec §1–§11*. Frontmatter, Status Map, Default Posture, Steps 0–4, Workpad Lifecycle/Template, Related Skills.
- **Modify:** `packages/core/src/workflow-loader.test.ts` — add a single Vitest case proving the parser accepts `Land` in `active_states` and the lifecycle classifies it as active.
- **No change:** `packages/core/src/workflow/parser.ts`, `packages/core/src/workflow/lifecycle.ts`, `packages/orchestrator/src/service.ts`, `packages/orchestrator/src/dispatch.ts`, `packages/worker/src/execution-phase.ts` — pre-verified to already accept arbitrary state strings (see Task 1 rationale).

**Out of scope for this plan** (each item from *Spec §13* needing its own future work):

- Creating `/gh-pr-writeup`, `/gh-project`, `/commit`, `/push`, `/pull` skills (referenced by WORKFLOW.md but not yet present locally). The new WORKFLOW.md *references* them as required skills; supplying them is a separate effort. Add a note in the project README's "Operational status" section once ready.
- Migration of any in-flight issues on the old project board (`PVT_kwHOAPiKdM4BRs_j`) before the cutover.
- Updating `e2e/seed/WORKFLOW.md` (uses the file-tracker stub; separate lifecycle).
- Extending `WORKFLOW_EXECUTION_PHASES` with a `landing` phase (optional polish — Land currently maps to `"implementation"`).

---

## Task 1: Add regression test proving `Land` works as an active state

**Why this task exists:** Code review of `parser.ts` (line 705 `readStringList`), `lifecycle.ts` (line 17 `isStateActive`), `service.ts` (line 283 dynamic activeStates output), and `worker/execution-phase.ts` (line 9 `resolveInitialExecutionPhase`) shows that all of these already accept arbitrary state strings and there is no allowlist anywhere in the code path. So flipping `WORKFLOW.md` to include `Land` in `active_states` requires no code change. This task locks that in with an automated test so the assumption can't silently break.

**Files:**
- Modify: `packages/core/src/workflow-loader.test.ts`

- [ ] **Step 1: Open `packages/core/src/workflow-loader.test.ts` and add the new test case at the end of the `describe("parseWorkflowMarkdown", ...)` block.**

  Find the last closing `});` of that describe (around line 320 — search for `describe("parseWorkflowMarkdown"` and scroll to the matching close) and insert the case just before it.

  Test code:

  ```typescript
  it("accepts Land as an active state for the Moncher Stack workflow", () => {
    const workflow = parseWorkflowMarkdown(`---
  tracker:
    kind: github-project
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
  codex:
    command: codex app-server
  ---
  Prompt body.
  `);

    expect(workflow.tracker.activeStates).toEqual(["Ready", "In progress", "Land"]);
    expect(workflow.lifecycle.activeStates).toContain("Land");
    expect(isStateActive("Land", workflow.lifecycle)).toBe(true);
    expect(isStateActive("In review", workflow.lifecycle)).toBe(false);
  });
  ```

- [ ] **Step 2: Ensure `isStateActive` is imported.** Check the top of `packages/core/src/workflow-loader.test.ts` — if `isStateActive` is not already imported, add it.

  ```typescript
  import { isStateActive } from "./workflow/lifecycle.js";
  ```

- [ ] **Step 3: Run the new test in isolation to verify it passes.**

  ```bash
  npx vitest run packages/core/src/workflow-loader.test.ts -t "accepts Land as an active state"
  ```

  Expected: PASS (1 test). If FAIL with "isStateActive is not defined" → revisit Step 2. If FAIL on assertion → re-read `parser.ts` `readStringList`; the parsing should already preserve the input array order.

- [ ] **Step 4: Run the full test file to make sure no existing test regressed.**

  ```bash
  npx vitest run packages/core/src/workflow-loader.test.ts
  ```

  Expected: all tests PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/core/src/workflow-loader.test.ts
  git commit -m "test(core): cover Land as an active workflow state

  Locks in that parseWorkflowMarkdown + isStateActive accept the new
  Land state used by the Moncher Stack workflow without code changes."
  ```

---

## Task 2: Create `.codex/skills/land/SKILL.md`

**Why this task exists:** *Spec §12* — the `/land` skill is the executable counterpart to WORKFLOW.md Step 4. It must exist at this exact path so the codex runtime can find it via the same discovery mechanism fleabucket-v2 uses.

**Files:**
- Create: `.codex/skills/land/SKILL.md`

- [ ] **Step 1: Confirm the parent directory exists and create it if not.**

  ```bash
  test -d .codex/skills || mkdir -p .codex/skills
  test -d .codex/skills/land || mkdir -p .codex/skills/land
  ls -la .codex/skills/land
  ```

  Expected: directory exists, empty (or only `.` `..`).

- [ ] **Step 2: Create `.codex/skills/land/SKILL.md` with the following content** (copied verbatim from *Spec §12*):

  ````markdown
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
  ````

  Use the `Write` tool with `file_path=.codex/skills/land/SKILL.md` and the content above (drop the surrounding markdown-code-block fences when writing).

- [ ] **Step 3: Verify the file exists and has the expected structure.**

  ```bash
  wc -l .codex/skills/land/SKILL.md
  head -10 .codex/skills/land/SKILL.md
  ```

  Expected: ~70 lines, frontmatter starts with `---`, `name: land`, `description: Merge an approved PR…`.

- [ ] **Step 4: Commit.**

  ```bash
  git add .codex/skills/land/SKILL.md
  git commit -m "feat(skills): add /land skill for Land state merge workflow

  Implements the executable counterpart to WORKFLOW.md Step 4 — pre-flight
  checks (approval, CI, branch freshness, changeset), squash merge with
  branch deletion, post-merge workpad bookkeeping, and Done transition.
  Codex worker discovers it via .codex/skills/<name>/SKILL.md convention."
  ```

---

## Task 3: Rewrite WORKFLOW.md frontmatter, Status Map, and Default Posture

**Why this task exists:** *Spec §1–§3*. These three sections form the workflow's contract — board identity, state semantics, and unconditional operating rules. Grouping them in one commit makes the "what changed about the board" diff reviewable as a unit.

**Files:**
- Modify: `WORKFLOW.md` (lines 1–67 of the current file)

- [ ] **Step 1: Read the current `WORKFLOW.md` from the top to confirm line ranges before editing.**

  ```bash
  head -70 WORKFLOW.md
  ```

  Expected: matches the original 5-state model with `project_id: PVT_kwHOAPiKdM4BRs_j`. If it has drifted from the spec's baseline, abort and re-investigate.

- [ ] **Step 2: Replace the frontmatter (`---` … `---` block at the top) with the version from *Spec §1*.**

  Use the `Edit` tool with `old_string` containing the current frontmatter (lines 1–33) and `new_string` containing:

  ```yaml
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
  ```

- [ ] **Step 3: Replace the `## Status Map` section** (the bullet list from `- **Backlog** [wait]…` through `- **Done** [terminal]…`) with the 6-row table from *Spec §2*.

  Use `Edit` with `old_string` being the entire bullet list and `new_string` being:

  ```markdown
  ## Status Map

  | Status | Role | Agent Action |
  | ------ | ---- | ------------ |
  | **Backlog** | wait | Agent ignores. Exit quietly without commenting. Also the parking lane for code-blocked issues — agent moves the issue here with a `⛔ Blocker` comment when a blocker is hit; human resolves and moves back to `Ready`. |
  | **Ready** | active | Triage scope and clarity. If a linked PR exists with unresolved review feedback, treat as a **rework re-entry** (see *Ready-return rework guard* in Step 0) and open a new work cycle before any code change. |
  | **In progress** | active | Implement → test → create or update PR. Each work cycle gets exactly one workpad comment; within the same cycle, update it in place. |
  | **In review** | wait | Pure human-review wait. Agent does **nothing** here except: if the PR has been merged, transition to `Done`; otherwise exit. Review rework is initiated by a human moving the issue back to `Ready` (or by the human approving and moving it to `Land`). |
  | **Land** | active | The human has approved the PR. Run `/land` skill: pre-flight checks (approval, CI, branch freshness) → squash merge → post-merge actions → transition to `Done`. |
  | **Done** | terminal | Completed. Agent exits immediately. |
  ```

- [ ] **Step 4: Replace the `### Default Posture` numbered list** with the 11-item version from *Spec §3*. The current Default Posture is items 1–10 immediately under the `### Default Posture` heading inside the `### Agent Instructions` section.

  Use `Edit` with `old_string` being the full current 10-item list and `new_string` being:

  ```markdown
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
  ```

- [ ] **Step 5: Run the workflow parser test from Task 1 against the modified `WORKFLOW.md` shape.** The repo's own `WORKFLOW.md` isn't loaded by any test directly, but we can sanity-check by running the loader test suite:

  ```bash
  npx vitest run packages/core/src/workflow-loader.test.ts
  ```

  Expected: all tests PASS, including the Task 1 case.

- [ ] **Step 6: Eye-check the modified file for breaks.**

  ```bash
  head -90 WORKFLOW.md
  ```

  Verify: the frontmatter starts with `---`, ends with `---`, has `project_id: PVT_kwHOAPiKdM4BYPVD`, has `Land` in `active_states`. The Status Map is a Markdown table (`| Status |`). Default Posture has 11 numbered items.

- [ ] **Step 7: Commit.**

  ```bash
  git add WORKFLOW.md
  git commit -m "docs(workflow): repoint to Moncher Stack + add Land state

  Updates frontmatter project_id to PVT_kwHOAPiKdM4BYPVD (hojinzs/projects/14)
  and adds Land to active_states. Rewrites Status Map as a 6-row table
  (Backlog/Ready/In progress/In review/Land/Done) and tightens Default
  Posture from 10 to 11 items: blocker scope (code-blocking only),
  two-part status transition log, /gh-project mandate, multi-line
  --body-file rule. See docs/superpowers/specs/2026-05-25-moncher-stack-workflow-design.md."
  ```

---

## Task 4: Rewrite WORKFLOW.md Steps 0–4 (the workflow procedure itself)

**Why this task exists:** *Spec §4–§8*. This is the meat of the workflow — the actual routing decisions and per-step procedure the agent follows. One commit because the steps are tightly cross-referenced (Step 0 mentions Step 2.8; Step 2 mentions Step 0 guards; Step 4 references Step 3 fallback).

**Files:**
- Modify: `WORKFLOW.md` (the `### Workflow` block — Step 0 through Step 3 currently; replace with Step 0 through Step 4)

- [ ] **Step 1: Locate the `### Workflow` heading in `WORKFLOW.md`.** It comes right after the `### Default Posture` block.

  ```bash
  grep -n "^### Workflow$\|^#### Step" WORKFLOW.md
  ```

  Expected: `### Workflow` heading, then 4 step subheadings (`#### Step 0` through `#### Step 3`). The replacement adds a 5th (`#### Step 4`).

- [ ] **Step 2: Replace the entire `### Workflow` block** (from `### Workflow` heading down to but not including the next sibling heading `### Guardrails`) with the new five-step version from *Spec §4–§8*.

  Use `Edit` with `old_string` being the full current Workflow block and `new_string` being:

  ````markdown
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
     - Pre-flight checks (approval, required CI checks, base-branch freshness — see the skill for the exact list).
     - Running `/pull` if the branch is behind, then re-running pre-flight from scratch.
     - Squash merge: `gh pr merge <pr-number> --squash --delete-branch`.
     - Recording the merged commit SHA and changeset path (if any) in the workpad.
     - Transitioning the issue to `Done` via `/gh-project` only after the merge succeeds.

  3. **Close the land cycle.** Once `/land` completes the Done transition, ensure the standalone `🔁 Status: Land → Done` comment was posted and the workpad Status Transitions line was appended (cycle N close: land).

  4. **On `/land` failure.** The skill records the failure and exits. If the same step fails 3 consecutive times for the same cause, write a `⛔ Blocker` comment, do **not** transition the issue, and exit. A human resolves the cause and either moves the issue back to `In review` (sends Step 4 home as a no-op next time) or re-enters `Land` after fixing the underlying problem.

  This step performs no code edits, commits, or pushes itself — only the workpad/comment bookkeeping around the skill call. Any rework code change must come through the `In review` → `Ready` → Step 2 path.
  ````

- [ ] **Step 3: Eye-check the modified file for break / heading order.**

  ```bash
  grep -n "^#### Step\|^### Workflow\|^### Guardrails\|^### Workpad" WORKFLOW.md
  ```

  Expected order: `### Workflow` → `#### Step 0` → `#### Step 1` → `#### Step 2` → `#### Step 3` → `#### Step 4` → `### Guardrails` (or whichever sibling section comes after Workflow, which we don't change in this task).

- [ ] **Step 4: Commit.**

  ```bash
  git add WORKFLOW.md
  git commit -m "docs(workflow): rewrite Steps 0-4 for Land workflow model

  Step 0 adds Ready-return rework guard + stalled-handoff safety net.
  Step 1 creates Draft PR upfront. Step 2 adds explicit Completion Bar
  + mandatory handoff gate. Step 3 becomes pure wait (defensive merge
  detection only). Step 4 is new — thin wrapper over the /land skill
  that performs pre-flight + squash merge + Done transition."
  ```

---

## Task 5: Rewrite Workpad Lifecycle, Template, and Related Skills

**Why this task exists:** *Spec §9–§11*. These trailing sections are the supporting reference docs — the cycle-table semantics that Steps 0/1/4 cross-reference, the new Workpad Template shape, and the Related Skills list with descriptions matching the new flow.

**Files:**
- Modify: `WORKFLOW.md` (everything from `### Workpad Lifecycle` to end of file)

- [ ] **Step 1: Locate the existing trailing sections.**

  ```bash
  grep -n "^### Workpad Lifecycle\|^### Workpad Template\|^### Related Skills\|^### Guardrails" WORKFLOW.md
  ```

  Expected: 4 headings (Guardrails, Workpad Lifecycle, Workpad Template, Related Skills). Note: Guardrails comes before Workpad Lifecycle in the current file, so we're only replacing from Workpad Lifecycle onward — Guardrails stays unchanged.

- [ ] **Step 2: Replace from `### Workpad Lifecycle` to end-of-file** with the version from *Spec §9–§11*.

  Use `Edit` with `old_string` being the full current tail (Workpad Lifecycle, Workpad Template, Related Skills) and `new_string` being:

  ````markdown
  ### Workpad Lifecycle

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

  ### Status Transition Log

  (See Posture 5 for the rule.) Every status transition produces two audit records:

  1. Standalone issue comment via `gh issue comment --body-file`:
     ```
     🔁 Status: `FROM` → `TO`

     Reason: <why now>
     Cycle: <N> open|close
     ```
  2. One append-only line in the current workpad's `### Status Transitions` section:
     ```
     - <ISO-8601 UTC ts> · `<FROM>` → `<TO>` · <reason> (cycle <N> open|close)
     ```

  `reason` is *why this transition now* — not a restatement of `TO`. "Completion Bar 통과, 핸드오프"·"리뷰 blocking 2건 rework", not "moved to In review".

  ### Workpad Template

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

  ### Related Skills

  All skills referenced by this workflow live under `.codex/skills/<name>/SKILL.md` so the codex-driven worker can discover them.

  - **`/gh-project`** — manage GitHub Project v2 status transitions and board placement. All Status field changes go through this skill (Posture 8).
  - **`/gh-pr-writeup`** — scaffold or refresh the PR body. Two modes:
    - *Initial Draft* (Step 1): create a new Draft PR with TL;DR · 변경 지점 다이어그램 · 여기부터 보세요 · 위험 & 롤백 · 변경 파일 · `## Issues — Closed #<N>` · 머지 후/사람 확인 placeholders.
    - *Refresh* (Step 2.8): update the same PR body before `gh pr ready`.
  - **`/commit`** — produce logical-unit commits in conventional commit format.
  - **`/push`** — push the feature branch to origin; updates the Draft PR automatically.
  - **`/pull`** — rebase or merge the PR base branch into the head branch. Used by the `/land` skill's branch-freshness step.
  - **`/land`** — execute the Land workflow: pre-flight checks → squash merge → post-merge bookkeeping → transition to `Done`. Triggered by Step 4.
  ````

  Note: the nested code-fence in the Workpad Template needs careful handling — Markdown supports nested fences only when the outer fence uses more backticks than the inner. The block above uses four backticks (` ```` `) for the outer Workpad Template fence and three for the inner Completion Bar code blocks. When pasting into `Edit`, keep that exact fence count.

- [ ] **Step 3: Confirm the file ends cleanly** — no orphan section, no stray code-fence.

  ```bash
  tail -30 WORKFLOW.md
  ```

  Expected: ends with the Related Skills bullet for `/land`. No truncation, no leftover content from the previous version.

- [ ] **Step 4: Final parser smoke — re-run the workflow-loader tests** to confirm nothing about the frontmatter shape regressed by accident.

  ```bash
  npx vitest run packages/core/src/workflow-loader.test.ts
  ```

  Expected: all PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add WORKFLOW.md
  git commit -m "docs(workflow): rewrite Workpad lifecycle, template, and related skills

  Adds the 6-row cycle transition table (including land cycle), the
  two-record status transition log convention, and a richer Workpad
  Template with Status Transitions / Completion Bar mirror / Rework
  feedback / 위임 (out-of-scope) sections. Related Skills now points
  at .codex/skills/<name>/SKILL.md and notes the two /gh-pr-writeup
  modes (Initial Draft + Refresh)."
  ```

---

## Task 6: Full verification — lint, test, typecheck, build

**Why this task exists:** *Spec §13 #4–#5* — confirm no code regression introduced by the WORKFLOW.md changes, even though they're document-only. Also runs `prettier` on the modified `WORKFLOW.md` (in case its line-break style drifted) and acts as the pre-merge sanity gate WORKFLOW.md Step 2.6 prescribes.

**Files:** none modified — verification only.

- [ ] **Step 1: Run lint.**

  ```bash
  pnpm lint
  ```

  Expected: PASS. If FAIL on Markdown files (eslint-mdx isn't typically configured here, but check), abort and fix.

- [ ] **Step 2: Run tests.**

  ```bash
  pnpm test
  ```

  Expected: all PASS, including the Task 1 case "accepts Land as an active state for the Moncher Stack workflow".

- [ ] **Step 3: Run typecheck.**

  ```bash
  pnpm typecheck
  ```

  Expected: PASS.

- [ ] **Step 4: Run build.**

  ```bash
  pnpm build
  ```

  Expected: PASS. All packages build.

- [ ] **Step 5: Confirm `prettier` is happy with the modified WORKFLOW.md.**

  ```bash
  pnpm format
  ```

  Expected: PASS. If `prettier` flags WORKFLOW.md (it may try to reflow tables or list items), run `pnpm format:write` and commit the formatting changes as a separate small commit:

  ```bash
  pnpm format:write
  git diff --name-only
  # If only WORKFLOW.md or other formatting-only changes appear:
  git add -p   # selectively stage formatting-only hunks
  git commit -m "style: prettier WORKFLOW.md"
  ```

- [ ] **Step 6: Spot-check the parsed config against the live project.**

  ```bash
  gh project view 14 --owner hojinzs --format json --jq '{id, title, fields: [.fields[] | select(.name == "Status") | .options[] | .name]}'
  ```

  Expected: `id` matches `PVT_kwHOAPiKdM4BYPVD`, `Status` options include `Backlog`, `Ready`, `In progress`, `In review`, `Land`, `Done`. If any name differs (case sensitivity matters in matching), fix the WORKFLOW.md `active_states` / `terminal_states` to exactly match the project's option names.

  Notes on the case-matching behavior: `isStateActive` in `lifecycle.ts` line 41 normalizes via `trim().toLowerCase()`. So `In progress` in WORKFLOW.md matches `IN PROGRESS` from GraphQL. But for human readability and consistency with the project board, keep them aligned.

- [ ] **Step 7: Final visual check of the WORKFLOW.md as it will appear to the agent.**

  ```bash
  wc -l WORKFLOW.md && head -100 WORKFLOW.md
  ```

  Expected: ~280 lines, frontmatter intact, Status Map renders as a table, Default Posture has 11 items, Workflow heading followed by Steps 0–4.

---

## Self-Review Checklist (for the implementer)

After completing Tasks 1–6, before opening the PR, run these final sanity checks:

- [ ] **Spec coverage:** Every numbered section in *Spec §1–§12* maps to a Task above (frontmatter §1 → Task 3, Status Map §2 → Task 3, Default Posture §3 → Task 3, Steps §4–§8 → Task 4, Workpad/Template §9–§10 → Task 5, Related Skills §11 → Task 5, `/land` skill §12 → Task 2, verification gates → Task 6).
- [ ] **No placeholders in WORKFLOW.md or SKILL.md:** search for `TBD`, `TODO`, `XXX`, `FIXME`. Expected: none.
- [ ] **`/land` skill references match WORKFLOW.md:** every step number cross-reference (`Step 2.6`, `Step 4.1`, etc.) actually exists with the right meaning in the updated WORKFLOW.md.
- [ ] **Cycle-marker convention consistent:** `(cycle N open)` / `(cycle N close)` form is used uniformly in both the WORKFLOW.md Status Transitions section and the standalone-comment template.
- [ ] **Spec §13 follow-ups noted:** create issues for the out-of-scope items if they're not yet tracked — the missing `/gh-pr-writeup` and `/gh-project` skills, the WORKFLOW_EXECUTION_PHASES landing-phase optional polish, and the migration cutover plan for in-flight issues on the old board.

---

## Cutover Note (for the human deploying this)

After all tasks land:

1. The orchestrator will start polling project `PVT_kwHOAPiKdM4BYPVD` on the next run cycle (default 30s polling).
2. Any in-flight issues still sitting on the old project `PVT_kwHOAPiKdM4BRs_j` will no longer be picked up — drain them to `Done` or `Backlog` on the old board first, or accept that they're stranded until manually moved.
3. The first issue moved to `Land` on the new board will exercise the `/land` skill end-to-end. If the prerequisite skills (`/gh-project`, `/gh-pr-writeup`, `/pull`) aren't yet present in `.codex/skills/`, the agent will blocker-comment and exit — this is intentional and surfaces the dependency.

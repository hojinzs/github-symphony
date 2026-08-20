# Init Workflow Ecosystem Enhancement

## TL;DR

> **Summary**: Extend `gh-symphony init` so that, beyond the minimal WORKFLOW.md, it automatically generates context.yaml (GitHub Project metadata), 6 agent skills (gh-symphony, gh-project, commit, push, pull, land), and reference-workflow.md. Division of labor: the CLI collects data, the AI agent designs the workflow.
> **Deliverables**: context.yaml generator, environment detection module, skill template infrastructure + 6 skills, reference-workflow.md generator, enhanced WORKFLOW.md, init command integration
> **Effort**: Large
> **Parallel**: YES — 3 waves
> **Critical Path**: Environment Detection → Context.yaml Generator → Init Integration

## Context

### Original Request

Referencing OpenAI Elixir Symphony's WORKFLOW.md (~400 lines), make `gh-symphony init` automatically generate a rich ecosystem so that the user's workflow-design effort is minimized. Currently it only generates a ~15-line basic WORKFLOW.md.

### Interview Summary

| Decision                     | Choice                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| init outputs                 | context.yaml + skills + minimal WORKFLOW.md + reference-workflow.md |
| Skill granularity            | Single `/gh-symphony` (detects state, then asks questions)          |
| Reference source             | Bundled with the CLI + per-runtime variants                         |
| Template engine              | Work around it ({{retry_context}} pattern), improve later           |
| GitHub Project communication | Provided by default at init via the `/gh-project` skill             |
| Related Skills               | commit, push, pull, land — init registers them all at once          |
| Init re-run                  | context.yaml is overwritten, skills are skipped if they exist       |

### Metis Review (gaps addressed)

1. **Field ID loss**: `getProjectDetail()`'s return value has only `option.name` extracted while `.id` is discarded → ID plumbing is mandatory when generating context.yaml
2. **Parser compatibility**: the enhanced WORKFLOW.md must use only the 8 supported variables (`issue.*` ×7 + `attempt`) — `renderPrompt()` strict mode throws on unsupported variables
3. **YAML special characters**: `Won't Do`, `In Progress (Blocked)`, etc. → quoting is mandatory when generating context.yaml
4. **Idempotency**: on init re-run, overwrite context.yaml; check for existing skill files and skip them
5. **Runtime branching**: create only the skill directory matching the selected runtime (codex/claude-code); never create both at once
6. **Scope guard**: the CLI does not generate the "rich" WORKFLOW.md — that is the AI agent's job. The CLI generates only a minimal+functional WORKFLOW.md.

## Work Objectives

### Core Objective

When `gh-symphony init` runs, automatically generate a complete ecosystem that enables the agent to design a precise workflow.

### Deliverables

1. `.gh-symphony/context.yaml` — GitHub Project metadata (including field IDs and option IDs)
2. `.gh-symphony/reference-workflow.md` — annotated reference template (per runtime)
3. `WORKFLOW.md` — enhanced minimal workflow (immediately runnable)
4. `.claude/skills/` or `.codex/skills/` — 6 agent skills
5. Environment detection module (package manager, test framework, CI)

### Definition of Done (verifiable conditions with commands)

- `pnpm --filter @gh-symphony/cli test` — all tests pass
- `pnpm typecheck` — type check passes
- `pnpm lint` — lint passes
- `pnpm build` — build succeeds
- On init run, verify that 6 files + 6 skills + WORKFLOW.md + reference-workflow.md are generated

### Must Have

- context.yaml includes field IDs and option IDs (needed for GitHub Project mutations)
- Environment detection: package manager, test command, CI platform
- 6 skills: gh-symphony, gh-project, commit, push, pull, land
- reference-workflow.md: the Elixir WORKFLOW.md-level structure translated into a GitHub Project version
- Enhanced WORKFLOW.md: status map + basic guardrails + workpad template
- Support for --skip-skills, --skip-context flags
- YAML special-character-safe quoting
- Skip overwriting when skill files exist (idempotency)

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)

- No changes to `packages/core/`, `packages/orchestrator/`, `packages/worker/`
- The CLI must not directly generate a 400-line "rich" WORKFLOW.md — that is the AI agent's job
- No tokens/secrets stored in context.yaml (it must be committable)
- Never generate skills for both runtimes at once (only the selected runtime)
- No new `{{custom_variable}}` patterns added to the WORKFLOW.md prompt body (out of scope since it requires changing core PromptVariables)
- No new template engines/libraries — use the existing string array pattern
- No interactive skill customization during init — generate with defaults, users edit later
- No GraphQL mutations — context.yaml stores IDs for the agent to use; init does not mutate

## Verification Strategy

> ZERO HUMAN INTERVENTION — all verification is agent-executed.

- Test decision: Tests-after (following the existing test patterns) — Vitest
- QA policy: every task includes agent-executed QA scenarios
- Evidence: .sisyphus/evidence/task-{N}-{slug}.{ext}
- Round-trip test: generateWorkflowMarkdown → parseWorkflowMarkdown → renderPrompt (strict mode)

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Foundation — 5 parallel tasks):

- Task 1: Environment detection module [quick]
- Task 2: Context.yaml types + generator [quick]
- Task 3: Skill writer infrastructure [quick]
- Task 4: Reference workflow generator [unspecified-low]
- Task 5: Enhanced WORKFLOW.md prompt body [quick]

Wave 2 (Skill Content — 2 parallel tasks, depends on Task 3):

- Task 6: Core skill templates (gh-symphony + gh-project) [unspecified-low]
- Task 7: Workflow skill templates (commit + push + pull + land) [quick]

Wave 3 (Integration — 1 task, depends on all above):

- Task 8: Wire into init command + integration tests [unspecified-high]

### Dependency Matrix

| Task                        | Depends On     | Blocks  |
| --------------------------- | -------------- | ------- |
| 1. Environment detection    | —              | 2, 8    |
| 2. Context.yaml generator   | 1 (types only) | 8       |
| 3. Skill writer infra       | —              | 6, 7, 8 |
| 4. Reference workflow       | —              | 8       |
| 5. Enhanced WORKFLOW.md     | —              | 8       |
| 6. Core skill templates     | 3              | 8       |
| 7. Workflow skill templates | 3              | 8       |
| 8. Init integration         | 1,2,3,4,5,6,7  | F1-F4   |

### Agent Dispatch Summary

| Wave  | Tasks | Categories                        |
| ----- | ----- | --------------------------------- |
| 1     | 5     | quick ×3, unspecified-low ×2      |
| 2     | 2     | unspecified-low ×1, quick ×1      |
| 3     | 1     | unspecified-high ×1               |
| Final | 4     | oracle, unspecified-high ×2, deep |

## TODOs

- [x] 1. Environment Detection Module

  **What to do**:
  Create `packages/cli/src/detection/environment-detector.ts`. A module that scans the current directory and auto-detects the project environment.

  Detection targets:
  - Package manager: `pnpm-lock.yaml` → pnpm, `package-lock.json` → npm, `yarn.lock` → yarn, `bun.lock` / `bun.lockb` → bun
  - Test command: parse `scripts.test` from `package.json` (null if absent)
  - Build command: parse `scripts.build` from `package.json` (null if absent)
  - Lint command: parse `scripts.lint` from `package.json` (null if absent)
  - CI platform: `.github/workflows/` exists → `github-actions`
  - Monorepo: `pnpm-workspace.yaml` or `lerna.json` or `workspaces` in package.json exists
  - Existing skills: scan the `.claude/skills/` or `.codex/skills/` directories

  Output type:

  ```typescript
  type DetectedEnvironment = {
    packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
    lockfile: string | null;
    testCommand: string | null;
    buildCommand: string | null;
    lintCommand: string | null;
    ciPlatform: "github-actions" | null;
    monorepo: boolean;
    existingSkills: string[]; // list of existing skill directory names
  };
  ```

  Filesystem access uses `access`, `readFile` from `fs/promises`. Graceful fallback (null/false) when a file is missing.

  **Must NOT do**:
  - No network requests
  - No full directory tree traversal (check only known paths)
  - No new external dependencies

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: single file, file-existence check logic, ~100 lines
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [2, 8] | Blocked By: []

  **References**:
  - Pattern: `packages/cli/src/mapping/smart-defaults.ts:6-21` — reference for the regex pattern-matching pattern
  - Pattern: `packages/cli/src/config.ts:136-146` — `readJsonFile` graceful error handling pattern
  - Type: `packages/cli/package.json` — check dependencies (no new external dependencies)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/detection/environment-detector.test.ts` passes
  - [ ] Detects `packageManager: "pnpm"` in a pnpm project
  - [ ] Correct detection for each of the npm/yarn/bun lockfiles
  - [ ] `packageManager: null` when no lockfile exists
  - [ ] Extracts test/build/lint commands from package.json scripts
  - [ ] `ciPlatform: "github-actions"` when .github/workflows/ exists
  - [ ] `pnpm typecheck` passes (strict mode)

  **QA Scenarios**:

  ```
  Scenario: pnpm monorepo detection
    Tool: Bash
    Steps: create pnpm-lock.yaml + pnpm-workspace.yaml + package.json(scripts.test="vitest") in a temp dir → call detectEnvironment()
    Expected: { packageManager: "pnpm", monorepo: true, testCommand: "vitest" }
    Evidence: .sisyphus/evidence/task-1-env-detect.txt

  Scenario: empty directory detection
    Tool: Bash
    Steps: call detectEnvironment() in an empty temp dir
    Expected: all fields null/false/[] — no throw
    Evidence: .sisyphus/evidence/task-1-env-detect-empty.txt
  ```

  **Commit**: YES | Message: `feat(cli): add environment detection module` | Files: [packages/cli/src/detection/environment-detector.ts, packages/cli/src/detection/environment-detector.test.ts]

---

- [x] 2. Context.yaml Schema and Generator

  **What to do**:
  Create two files in the `packages/cli/src/context/` directory:
  1. `context-types.ts` — ContextYaml type definition
  2. `generate-context-yaml.ts` — build the context.yaml string + write the file

  **Type definition** (`context-types.ts`):

  ```typescript
  type ContextYaml = {
    schema_version: 1;
    collected_at: string; // ISO 8601
    project: {
      id: string;
      title: string;
      url: string;
    };
    status_field: {
      id: string;
      name: string;
      columns: Array<{
        id: string;
        name: string;
        color: string | null;
        inferred_role: "active" | "wait" | "terminal" | null;
        confidence: "high" | "low";
      }>;
    };
    text_fields: Array<{
      id: string;
      name: string;
      data_type: string;
      inferred_purpose: "blocker" | null;
    }>;
    repositories: Array<{
      owner: string;
      name: string;
      clone_url: string;
    }>;
    detected_environment: DetectedEnvironment; // type from Task 1
    runtime: {
      agent: string; // "codex" | "claude-code" | "custom"
      agent_command: string;
    };
  };
  ```

  **Generator function** (`generate-context-yaml.ts`):
  - Input: `ProjectDetail` + `StatusFieldOption[]` (including IDs) + `DetectedEnvironment` + runtime info
  - Output: YAML string (pure string building, no yaml library)
  - YAML quoting: wrap values in `"..."` when they contain `:`, `#`, `'`, `"`, `[`, `]`, `{`, `}`
  - File write: `writeContextYaml(outputDir, context)` — `mkdir -p` + atomic write (tmp+rename)
  - Key point: pass `statusField.id`, `option.id`, `option.color` from the `getProjectDetail()` return value **through as-is** — unlike the current `init.ts:176`, which extracts only `option.name`, preserve all IDs

  **Must NOT do**:
  - No external yaml library (the existing core parser also uses its own YAML parser)
  - No tokens/secrets included in context.yaml
  - No fields added to context.yaml that are used by commands other than `gh-symphony init`

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: type definition + YAML string building, ~150 lines
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [8] | Blocked By: [1 (type import only)]

  **References**:
  - Pattern: `packages/cli/src/workflow/generate-workflow-md.ts:23-80` — string array build + join pattern
  - Pattern: `packages/cli/src/config.ts:148-153` — atomic write (tmp + rename) pattern
  - API: `packages/cli/src/github/client.ts:28-33` — `StatusFieldOption` type (id, name, color)
  - API: `packages/cli/src/github/client.ts:35-39` — `ProjectStatusField` type (id, name, options)
  - API: `packages/cli/src/github/client.ts:54-61` — `ProjectDetail` type (statusFields, textFields, linkedRepositories)
  - Pattern: `packages/cli/src/mapping/smart-defaults.ts:29-39` — call `inferStateRole()` to fill role/confidence

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/context/generate-context-yaml.test.ts` passes
  - [ ] The generated YAML includes field IDs and option IDs
  - [ ] Column names containing special characters (`Won't Do`, `In Progress (Blocked)`) are safely quoted
  - [ ] No token appears in the output
  - [ ] Includes `schema_version: 1`
  - [ ] `pnpm typecheck` passes

  **QA Scenarios**:

  ```
  Scenario: normal context.yaml generation
    Tool: Bash
    Steps: mock ProjectDetail (3 columns, 2 repos, 1 text field) → generateContextYaml() → read the file → validate structure
    Expected: project.id, status_field.columns[].id, repositories[].clone_url all present
    Evidence: .sisyphus/evidence/task-2-context-yaml.txt

  Scenario: special character quoting
    Tool: Bash
    Steps: column names "Won't Do" + "In Progress (Blocked)" → generateContextYaml() → validate YAML parsing
    Expected: values wrapped in double quotes, original strings restored on parse
    Evidence: .sisyphus/evidence/task-2-context-yaml-special.txt
  ```

  **Commit**: YES | Message: `feat(cli): add context.yaml schema and generator` | Files: [packages/cli/src/context/context-types.ts, packages/cli/src/context/generate-context-yaml.ts, packages/cli/src/context/generate-context-yaml.test.ts]

---

- [x] 3. Skill Writer Infrastructure

  **What to do**:
  Create the skill file writing infrastructure in the `packages/cli/src/skills/` directory:
  1. `types.ts` — skill template type definitions
  2. `skill-writer.ts` — utility that writes skill files to disk

  **Types** (`types.ts`):

  ```typescript
  type SkillRuntime = "claude-code" | "codex";

  type SkillTemplate = {
    name: string; // e.g., "gh-symphony"
    fileName: string; // e.g., "SKILL.md" or "gh-symphony.md"
    generate: (context: SkillTemplateContext) => string;
  };

  type SkillTemplateContext = {
    runtime: SkillRuntime;
    projectId: string;
    projectTitle: string;
    repositories: Array<{ owner: string; name: string }>;
    statusColumns: Array<{
      id: string; // option ID (needed for GitHub Project mutations)
      name: string;
      role: "active" | "wait" | "terminal" | null;
    }>;
    statusFieldId: string; // field ID (needed for GitHub Project mutations)
    contextYamlPath: string; // relative path
    referenceWorkflowPath: string; // relative path
  };
  ```

  **Note**: `statusColumns` must include `id` — needed for Task 6's gh-project skill to dynamically generate the Column ID Quick Reference table. `statusFieldId` is needed for the `gh project item-edit --field-id` command.

  **Writer** (`skill-writer.ts`):
  - `resolveSkillsDir(repoRoot, runtime)` → `claude-code` → `.claude/skills/`, `codex` → `.codex/skills/`. When `runtime` is neither of these two values (custom, etc.), return `null` → the caller decides to skip skill generation.
  - `writeSkillFile(skillsDir, template, context, options?)` → writes an individual skill file
    - `mkdir -p` if the directory does not exist
    - Skip by default if the file exists (overwrite when options.overwrite=true)
    - atomic write (tmp + rename)
  - `writeAllSkills(repoRoot, runtime, templates[], context)` → writes all skills in one pass
    - Returns: `{ written: string[], skipped: string[] }` — for displaying the result to the user

  **Skill directory structure**:

  ```
  .claude/skills/           (claude-code runtime)
    gh-symphony/SKILL.md
    gh-project/SKILL.md
    commit/SKILL.md
    push/SKILL.md
    pull/SKILL.md
    land/SKILL.md

  .codex/skills/            (codex runtime)
    gh-symphony/SKILL.md
    gh-project/SKILL.md
    commit/SKILL.md
    push/SKILL.md
    pull/SKILL.md
    land/SKILL.md
  ```

  **Must NOT do**:
  - Never create both runtime directories at once
  - Never unconditionally overwrite existing skill files (default=skip)
  - Skill content (templates) is not written in this task — infrastructure only

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: file I/O utility, ~100 lines
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [6, 7, 8] | Blocked By: []

  **References**:
  - Pattern: `packages/cli/src/config.ts:148-153` — atomic write pattern (tmp + rename)
  - Pattern: `packages/cli/src/config.ts:43-48` — `tenantConfigDir()` path building pattern
  - Test: `packages/cli/src/commands/init.test.ts:11` — `mkdtemp()` temp dir pattern

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/skills/skill-writer.test.ts` passes
  - [ ] claude-code runtime → files created in `.claude/skills/`
  - [ ] codex runtime → files created in `.codex/skills/`
  - [ ] custom runtime → `resolveSkillsDir()` returns `null`, `writeAllSkills()` skips gracefully
  - [ ] When an existing file is present, skip + include it in the skipped array
  - [ ] Overwrite when overwrite=true
  - [ ] `pnpm typecheck` passes

  **QA Scenarios**:

  ```
  Scenario: write skill file (claude-code)
    Tool: Bash
    Steps: call writeSkillFile() with a mock template in a temp dir (runtime="claude-code")
    Expected: .claude/skills/test-skill/SKILL.md file exists, content matches
    Evidence: .sisyphus/evidence/task-3-skill-write.txt

  Scenario: skip existing file
    Tool: Bash
    Steps: an already-existing skill file → call writeSkillFile() (overwrite=false)
    Expected: file content unchanged, included in the skipped array
    Evidence: .sisyphus/evidence/task-3-skill-skip.txt
  ```

  **Commit**: YES | Message: `feat(cli): add skill writer infrastructure` | Files: [packages/cli/src/skills/types.ts, packages/cli/src/skills/skill-writer.ts, packages/cli/src/skills/skill-writer.test.ts]

---

- [x] 4. Reference Workflow Generator

  **What to do**:
  Create `packages/cli/src/workflow/generate-reference-workflow.ts`. A function that generates an annotated reference template translating the Elixir Symphony WORKFLOW.md into a GitHub Project version.

  **Function signature**:

  ```typescript
  type ReferenceWorkflowInput = {
    runtime: "codex" | "claude-code" | string;
    statusColumns: Array<{
      name: string;
      role: "active" | "wait" | "terminal" | null;
    }>;
    repositories: Array<{ owner: string; name: string }>;
    projectId: string;
    blockedByFieldName?: string;
  };

  function generateReferenceWorkflow(input: ReferenceWorkflowInput): string;
  ```

  **Output structure** (annotated complete WORKFLOW.md reference):

  ```markdown
  # Reference WORKFLOW.md — gh-symphony

  # This file is a reference template to consult when writing WORKFLOW.md.

  # The AI agent consults this file via the /gh-symphony skill to design WORKFLOW.md.

  # Do not edit this file directly.

  ---

  # ═══ FRONT MATTER FIELD REFERENCE ═══

  # Below are all the front matter fields supported by the gh-symphony parser.

  github_project_id: {projectId}
  allowed_repositories:

  - {owner}/{name}

  lifecycle:
  state_field: Status
  active_states: [...]
  terminal_states: [...]
  blocker_check_states: [...]

  # blocked_by_field: "Blocked By" # text field name (optional)

  runtime:
  agent_command: {runtime-specific command}
  max_turns: 20
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000

  hooks:
  after_create: | # {package-manager-specific default script}
  before_run: null
  after_run: null
  before_remove: null

  scheduler:
  poll_interval_ms: 30000

  retry:
  base_delay_ms: 1000
  max_delay_ms: 30000

  ---

  # ═══ PROMPT BODY REFERENCE ═══

  # Below is a reference translating Elixir Symphony into a GitHub Project version.

  ## Status Map

  {detailed behavior guide per status column}

  ## Default Posture

  {13 behavior principles}

  ## Related Skills

  {descriptions of gh-project, commit, push, pull, land}

  ## Step 0: Determine current state and route

  {routing per state}

  ## Step 1: Start/continue execution

  {execution setup, workpad creation}

  ## Step 2: Execution phase

  {implementation, tests, PR creation}

  ## Step 3: Human Review and merge handling

  {review wait, merge flow}

  ## Step 4: Rework handling

  {rework policy}

  ## PR Feedback Sweep Protocol

  {PR feedback handling}

  ## Completion Bar

  {checklist before Human Review}

  ## Guardrails

  {safety rules}

  ## Workpad Template

  {workpad markdown structure}
  ```

  Per-runtime differences:
  - **codex**: `agent_command: bash -lc codex app-server`, sandbox settings comment
  - **claude-code**: `agent_command: bash -lc claude-code`, different sandbox guidance

  **Must NOT do**:
  - This file must not become an executable WORKFLOW.md — it is for reference
  - No `{{template_variable}}` usage (this file is not a render target, it is a reference document)
  - Instead, use single-brace `{placeholder}` to mark comments/examples

  **Recommended Agent Profile**:
  - Category: `unspecified-low` — Reason: large string template authoring, content design required
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [8] | Blocked By: []

  **References**:
  - External: Elixir Symphony WORKFLOW.md — https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md (reference for the main structure)
  - Pattern: `packages/cli/src/workflow/generate-workflow-md.ts:17-21` — markdown generation pattern
  - Schema: `packages/core/src/workflow/config.ts:34-48` — ParsedWorkflow/WorkflowDefinition field list (the exact list of supported front matter fields)
  - Schema: `packages/core/src/workflow/parser.ts:63-148` — all fields the parser reads (the exact source for the front matter reference)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/workflow/generate-reference-workflow.test.ts` passes
  - [ ] The output includes every supported front matter field with comments
  - [ ] Reflects the agent_command difference between the codex and claude-code runtimes
  - [ ] The Status Map includes the detailed behavior guide for each input column
  - [ ] No `{{...}}` pattern in the output (double braces forbidden)
  - [ ] `pnpm typecheck` passes

  **QA Scenarios**:

  ```
  Scenario: codex runtime reference generation
    Tool: Bash
    Steps: 3 status columns + codex runtime → generateReferenceWorkflow() → validate the output
    Expected: agent_command contains "codex", all section headers present
    Evidence: .sisyphus/evidence/task-4-ref-workflow-codex.txt

  Scenario: claude-code runtime reference generation
    Tool: Bash
    Steps: same input + claude-code runtime → validate the output
    Expected: agent_command contains "claude-code", content differs from codex
    Evidence: .sisyphus/evidence/task-4-ref-workflow-claude.txt
  ```

  **Commit**: YES | Message: `feat(cli): add reference workflow generator` | Files: [packages/cli/src/workflow/generate-reference-workflow.ts, packages/cli/src/workflow/generate-reference-workflow.test.ts]

---

- [x] 5. Enhanced WORKFLOW.md Prompt Body

  **What to do**:
  Extend the `buildPromptBody()` function in `packages/cli/src/workflow/generate-workflow-md.ts` to make the current 6-line generic instructions richer.

  **Current** (`generate-workflow-md.ts:93-115`):

  ```
  ## Status Map
  - **Todo** [active]

  ## Agent Instructions
  You are an AI coding agent working on issue {{issue.identifier}}...
  1. Read the issue description...
  2. Explore the codebase...
  (6 steps)
  ```

  **After the change** (added sections):

  ```markdown
  ## Status Map

  - **Todo** [active] — agent starts work immediately
  - **In Progress** [active] — implementation in progress
  - **Review** [wait] — PR created, waiting for human review
  - **Done** [terminal] — complete, agent exits

  ## Agent Instructions

  You are an AI coding agent working on issue {{issue.identifier}}: "{{issue.title}}".

  **Repository:** {{issue.repository}}
  **Current state:** {{issue.state}}

  ### Task

  {{issue.description}}

  ### Default Posture

  1. This is an unattended orchestration session. Do not ask a human for follow-up work.
  2. Stop early only for a genuine blocker (missing required permission/secret).
  3. In the final message, report only completed work and blockers. Do not include "next steps".

  ### Workflow

  1. Read the issue description and understand the requirements.
  2. Explore the codebase and identify the relevant code structure.
  3. Implement the change following the project's coding conventions.
  4. Write or update tests covering the change.
  5. Verify that all existing tests pass.
  6. Create a PR with a clear description of the change.

  ### Guardrails

  - Do not edit the issue body for planning or progress-tracking purposes.
  - For issues in a terminal state, do nothing and exit.
  - If you find out-of-scope improvements, do not expand the current scope; create a separate issue.

  ### Workpad Template

  Create a workpad with the structure below as an issue comment to track progress:

  \`\`\`md

  ## Workpad

  ### Plan

  - [ ] 1. Work item

  ### Acceptance Criteria

  - [ ] Criterion 1

  ### Validation

  - [ ] Test: `command`

  ### Notes

  - Progress notes
    \`\`\`
  ```

  **Key constraint**: the variables used must be only `issue.identifier`, `issue.title`, `issue.repository`, `issue.state`, `issue.description` — use only what is defined in `PromptVariables`, i.e. these 8 (`issue.*` ×7 + `attempt`).

  **Must NOT do**:
  - No variables absent from core, such as `{{issue.labels}}`, `{{retry_context}}`
  - No generating a 400-line Elixir-level detailed workflow — that is the AI skill's job
  - Minimize changes to the existing `GenerateWorkflowInput` type

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: extends an existing function, string changes
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [8] | Blocked By: []

  **References**:
  - Pattern: `packages/cli/src/workflow/generate-workflow-md.ts:93-115` — current buildPromptBody() (the modification target)
  - Pattern: `packages/cli/src/mapping/smart-defaults.ts:134-146` — generateStatusMap() (per-role descriptions can be added)
  - Test: `packages/cli/src/workflow/generate-workflow-md.test.ts` — existing tests (check backward compat)
  - Constraint: `packages/core/src/workflow/render.ts:9-18` — PromptIssueVariables (list of available variables)
  - Constraint: `packages/core/src/workflow/render.ts:80-112` — renderPrompt() strict mode (throws on unsupported variables)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/workflow/generate-workflow-md.test.ts` passes
  - [ ] Existing tests pass without changes (backward compatibility)
  - [ ] Generated WORKFLOW.md → parses cleanly via `parseWorkflowMarkdown()`
  - [ ] Parsed promptTemplate → `renderPrompt(template, testVars, { strict: true })` does not throw
  - [ ] The Status Map includes a one-line description per role
  - [ ] Includes the Default Posture, Guardrails, and Workpad Template sections
  - [ ] `pnpm typecheck` passes

  **QA Scenarios**:

  ```
  Scenario: Round-trip test (strict mode)
    Tool: Bash
    Steps: generateWorkflowMarkdown(input) → parseWorkflowMarkdown(md) → renderPrompt(parsed.promptTemplate, mockVars, {strict:true})
    Expected: no throw, all {{variables}} substituted
    Evidence: .sisyphus/evidence/task-5-roundtrip.txt

  Scenario: Backward compatibility
    Tool: Bash
    Steps: generateWorkflowMarkdown() with existing test fixtures → check whether the previous output structure is included
    Expected: existing "Agent Instructions" section structure preserved
    Evidence: .sisyphus/evidence/task-5-backward-compat.txt
  ```

  **Commit**: YES | Message: `feat(cli): enhance WORKFLOW.md with richer prompt body` | Files: [packages/cli/src/workflow/generate-workflow-md.ts, packages/cli/src/workflow/generate-workflow-md.test.ts]

---

- [x] 6. Core Skill Templates (gh-symphony + gh-project)

  **What to do**:
  Create two core skill templates in the `packages/cli/src/skills/templates/` directory:

  **6a. `gh-symphony.ts`** — main workflow design/refinement skill:

  ```typescript
  export function generateGhSymphonySkill(ctx: SkillTemplateContext): string;
  ```

  Skill content:
  - Trigger: when the user wants to create/improve WORKFLOW.md
  - Mode detection: auto-detect design/refine based on whether WORKFLOW.md exists → ask the user
  - Context files: `.gh-symphony/context.yaml` (required), `.gh-symphony/reference-workflow.md` (required), `WORKFLOW.md` (refine if present)
  - Design mode: read context.yaml → analyze the repo structure → consult reference-workflow.md → ask the user the key decision questions → generate WORKFLOW.md
  - Refine mode: compare the current WORKFLOW.md vs the reference → identify missing sections → propose improvements → apply
  - Validate mode: check parser compatibility, verify required sections exist
  - List of sections that must be included (Status map, Default posture, Execution flow, PR feedback, Guardrails, etc.)
  - List of supported front matter fields (extracted from the parser schema)
  - List of available template variables (8: issue.\* + attempt)
  - Related skills references (gh-project, commit, push, pull, land)

  **6b. `gh-project.ts`** — GitHub Project communication skill:

  ```typescript
  export function generateGhProjectSkill(ctx: SkillTemplateContext): string;
  ```

  Skill content:
  - Purpose: manage issue state by communicating with the GitHub Project v2 board
  - Prerequisites: `gh` CLI authenticated, `.gh-symphony/context.yaml` exists
  - Operations:
    - Change issue state: `gh project item-edit` command + reference the field ID / option ID from context.yaml
    - Workpad comments: create with `gh issue comment`, update with `gh api` PATCH
    - Create follow-up issues: `gh issue create` command
    - Label management: `gh issue edit --add-label`
  - Column ID Quick Reference: dynamically generated from `ctx.statusColumns` (name → role → option ID table)
  - Rules: follow the WORKFLOW.md status map flow, verify the completion bar before transitioning to a terminal state

  **Must NOT do**:
  - No `{{template_variable}}` in skill content (that is for WORKFLOW.md; skill files are static markdown)
  - No hardcoded tokens/secrets in skill files
  - No writing actual GraphQL mutation code — `gh` CLI command examples only
  - No Python/JS code blocks in skill files — markdown + shell command examples only

  **Recommended Agent Profile**:
  - Category: `unspecified-low` — Reason: content design required, translating the Elixir reference, ~200 lines each
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [3]

  **References**:
  - External: Elixir Symphony WORKFLOW.md — https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md (reference for the Default posture, Status map, Steps 0-4, Guardrails, Workpad template structure)
  - Type: `packages/cli/src/skills/types.ts` — SkillTemplate, SkillTemplateContext (created in Task 3)
  - Schema: `packages/core/src/workflow/config.ts:34-48` — ParsedWorkflow field list
  - Schema: `packages/core/src/workflow/render.ts:9-18` — PromptIssueVariables (available variables)
  - API: `packages/cli/src/github/client.ts:28-33` — StatusFieldOption type (the ID structure the skill references)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/skills/templates/gh-symphony.test.ts` passes
  - [ ] `npx vitest run packages/cli/src/skills/templates/gh-project.test.ts` passes
  - [ ] The gh-symphony skill includes "Mode detection", "Design mode", and "Refine mode" sections
  - [ ] The gh-symphony skill references the context.yaml and reference-workflow.md paths
  - [ ] The gh-project skill includes `gh project item-edit` command examples
  - [ ] The gh-project skill dynamically generates the Column ID Quick Reference table from context.yaml
  - [ ] No `{{...}}` double-brace patterns in the skill output
  - [ ] `pnpm typecheck` passes

  **QA Scenarios**:

  ```
  Scenario: gh-symphony skill generation
    Tool: Bash
    Steps: mock context (3 columns, 2 repos) → generateGhSymphonySkill() → validate the output
    Expected: "Mode detection", "Design", "Refine", "Related Skills" sections all present
    Evidence: .sisyphus/evidence/task-6-gh-symphony-skill.txt

  Scenario: gh-project skill's Column ID table
    Tool: Bash
    Steps: mock columns with IDs → generateGhProjectSkill() → parse the table
    Expected: each column's name, role, option_id present as a table row
    Evidence: .sisyphus/evidence/task-6-gh-project-skill.txt
  ```

  **Commit**: YES | Message: `feat(cli): add core skill templates (gh-symphony, gh-project)` | Files: [packages/cli/src/skills/templates/gh-symphony.ts, packages/cli/src/skills/templates/gh-project.ts, packages/cli/src/skills/templates/gh-symphony.test.ts, packages/cli/src/skills/templates/gh-project.test.ts]

---

- [x] 7. Workflow Skill Templates (commit, push, pull, land)

  **What to do**:
  Create 4 workflow skill templates in the `packages/cli/src/skills/templates/` directory:

  **7a. `commit.ts`**:
  - Split commits into logical units
  - Conventional commit format: `<type>(<scope>): <description>`
  - types: feat, fix, refactor, test, docs, chore
  - No intermediate commits that break tests
  - No committing temporary debug code

  **7b. `push.ts`**:
  - Verify local tests/lint pass before pushing
  - `git push origin <branch> [-u]`
  - On failure: pull → resolve → retry the push
  - No force push (only --force-with-lease allowed, with the reason recorded)
  - Record the result in the workpad

  **7c. `pull.ts`**:
  - `git fetch origin main` → `git merge origin/main`
  - On conflict: resolve → test → commit
  - Record pull skill evidence (source, result, HEAD SHA)
  - Re-run tests after the merge

  **7d. `land.ts`**:
  - Verify the PR is in approved state
  - Verify all CI checks are green
  - Verify the branch is up-to-date with base
  - If all pass, `gh pr merge` (--squash/--merge/--rebase per project policy)
  - On merge success → transition the issue state to Done (see the gh-project skill)
  - On merge failure → record in the workpad + retry
  - Guide agents to follow this skill's flow instead of calling `gh pr merge` directly

  **7e. `index.ts`** — barrel export:

  ```typescript
  export { generateCommitSkill } from "./commit.js";
  export { generatePushSkill } from "./push.js";
  export { generatePullSkill } from "./pull.js";
  export { generateLandSkill } from "./land.js";
  export { generateGhSymphonySkill } from "./gh-symphony.js";
  export { generateGhProjectSkill } from "./gh-project.js";

  export const ALL_SKILL_TEMPLATES: SkillTemplate[] = [...];
  ```

  Each function signature: `(ctx: SkillTemplateContext) => string`
  These 4 skills are context-independent (general-purpose skills that do not depend on project metadata, but they take SkillTemplateContext so they can use runtime info, etc.).

  **Must NOT do**:
  - No project-specific logic (these 4 are general-purpose skills)
  - No generating executable scripts — markdown guides only
  - No duplicating the gh-project skill's role (state transitions) — land delegates via "see the gh-project skill"

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: all 4 are relatively short markdown templates (~50 lines each)
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [3]

  **References**:
  - External: Elixir Symphony WORKFLOW.md "Related skills" section — references the commit, push, pull, land skills
  - Type: `packages/cli/src/skills/types.ts` — SkillTemplate, SkillTemplateContext (Task 3)
  - Pattern: `packages/cli/src/skills/templates/gh-symphony.ts` — sibling skill in the same directory (Task 6)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/skills/templates/commit.test.ts` passes
  - [ ] `npx vitest run packages/cli/src/skills/templates/push.test.ts` passes
  - [ ] `npx vitest run packages/cli/src/skills/templates/pull.test.ts` passes
  - [ ] `npx vitest run packages/cli/src/skills/templates/land.test.ts` passes
  - [ ] Each skill includes a "## Flow" or "## Rules" section
  - [ ] The land skill delegates state transitions via "see the gh-project skill"
  - [ ] The barrel export `ALL_SKILL_TEMPLATES` includes all 6
  - [ ] `pnpm typecheck` passes

  **QA Scenarios**:

  ```
  Scenario: generate all skills + barrel export
    Tool: Bash
    Steps: ALL_SKILL_TEMPLATES.map(t => t.generate(mockCtx)) → validate the 6 outputs
    Expected: all 6 skills return non-empty markdown strings
    Evidence: .sisyphus/evidence/task-7-all-skills.txt

  Scenario: land skill gh-project reference
    Tool: Bash
    Steps: generateLandSkill(mockCtx) → check the string "gh-project" exists
    Expected: includes a reference to the "gh-project" skill
    Evidence: .sisyphus/evidence/task-7-land-ref.txt
  ```

  **Commit**: YES | Message: `feat(cli): add workflow skill templates (commit, push, pull, land)` | Files: [packages/cli/src/skills/templates/commit.ts, packages/cli/src/skills/templates/push.ts, packages/cli/src/skills/templates/pull.ts, packages/cli/src/skills/templates/land.ts, packages/cli/src/skills/templates/index.ts, packages/cli/src/skills/templates/*.test.ts]

---

- [x] 8. Wire Workflow Ecosystem into Init Command

  **What to do**:
  Modify `packages/cli/src/commands/init.ts` to integrate the modules from Tasks 1-7. Wire init so it generates the full ecosystem on run.

  **Changes**:

  **8a. Add new flags** (`parseInitFlags`):

  ```typescript
  type InitFlags = {
    nonInteractive: boolean;
    token?: string;
    project?: string;
    output?: string;
    skipSkills: boolean; // NEW
    skipContext: boolean; // NEW
  };
  ```

  `--skip-skills`: skip generating skill files
  `--skip-context`: skip generating context.yaml

  **Runtime and skill generation rules**:
  - `codex` → generate the 6 skills in `.codex/skills/`
  - `claude-code` → generate the 6 skills in `.claude/skills/`
  - `custom` → skip skill generation (no known skill directory). context.yaml + reference-workflow.md are still generated.

  **8b. Extend `runNonInteractive()`**:
  After the existing WORKFLOW.md generation, add:
  1. Call `detectEnvironment(cwd)` → detect the environment
  2. `generateContextYaml(projectDetail, statusField, env, runtime)` → write `.gh-symphony/context.yaml`
  3. `generateReferenceWorkflow(input)` → write `.gh-symphony/reference-workflow.md`
  4. `writeAllSkills(cwd, runtime, ALL_SKILL_TEMPLATES, context)` → write the skill files
  5. Print results: list of generated files + list of skipped skills

  **8c. Extend `runInteractiveStandalone()`**:
  After the existing Step 4, before writing WORKFLOW.md:
  1. Add a runtime selection prompt (codex/claude-code/custom) — same pattern as `tenant add`'s `tenantAddInteractive()` (tenant.ts:401-420). When custom is selected, take the custom command via `p.text()`.
  2. Runtime value flow:
     - `runtime` (string: "codex" | "claude-code" | "custom") → passed to the `runtime` field of WORKFLOW.md generation → use `resolveAgentCommand(runtime)` or the custom command
     - `runtime` → stored in context.yaml's `runtime.agent` field. For custom: `runtime.agent: "custom"`, `runtime.agent_command: "the command the user entered"`
     - `runtime` → `resolveSkillsDir(cwd, runtime)`: generate skills for codex/claude-code; for custom it returns null → skip skill generation, `p.log.warn("The custom runtime does not support automatic skill generation.")`
  3. Environment detection → context.yaml → reference-workflow.md → write skills
  4. Update the outro message: announce the list of generated files

  **8d. Extend `runInteractiveFromTenant()`**:
  After the existing WORKFLOW.md generation:
  1. Extract the runtime from the tenant config
  2. The rest is identical (context.yaml + reference + skills)

  **8e. No changes to `writeConfig()`** (scope limitation):
  `writeConfig()` is also imported by `tenant.ts` and only receives `configDir` (the tenant config directory). The ecosystem files (context.yaml, skills, reference-workflow.md) must be written to the **repo root**, so do not add them to `writeConfig()`.
  Instead, add the ecosystem generation logic directly to each of `runNonInteractive()`, `runInteractiveStandalone()`, and `runInteractiveFromTenant()`. The repo root is `process.cwd()` (the premise is that init is always run inside the repo). `tenant add` does not generate ecosystem files — that is `init`'s job.

  **Field ID plumbing** (Metis's point):
  Currently `init.ts:176` extracts only names via `statusField.options.map(o => o.name)`.
  → Pass the entire `statusField` object (`ProjectStatusField` with `.id`, `.options[].id`) to the context.yaml generator.

  **Idempotency handling**:
  - `.gh-symphony/context.yaml`: always overwrite (reflect the latest project data)
  - `.gh-symphony/reference-workflow.md`: always overwrite
  - `WORKFLOW.md`: keep the existing init behavior (always overwrite)
  - Skill files: skip when they exist (skill-writer's default behavior)

  **Must NOT do**:
  - No changing the core behavior of the existing init flow (WORKFLOW.md generation stays as-is)
  - No changing tenant.ts import paths (writeConfig, generateTenantId, abortIfCancelled)
  - No deleting existing tests — extend only

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: modifies existing code, integrates many modules, must guarantee compatibility with existing tests
  - Skills: [] — no special skills needed
  - Omitted: [`playwright`] — no browser needed

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1-F4] | Blocked By: [1, 2, 3, 4, 5, 6, 7]

  **References**:
  - Modify: `packages/cli/src/commands/init.ts:60-86` — parseInitFlags (add new flags)
  - Modify: `packages/cli/src/commands/init.ts:108-224` — runNonInteractive (add ecosystem generation)
  - Modify: `packages/cli/src/commands/init.ts:325-503` — runInteractiveStandalone (runtime prompt + ecosystem)
  - Modify: `packages/cli/src/commands/init.ts:244-321` — runInteractiveFromTenant (add ecosystem)
  - Note: `writeConfig()` (init.ts:570-647) is not modified — it is also used by tenant.ts, and the ecosystem is init-only
  - Import: `packages/cli/src/detection/environment-detector.ts` — detectEnvironment (Task 1)
  - Import: `packages/cli/src/context/generate-context-yaml.ts` — generateContextYaml, writeContextYaml (Task 2)
  - Import: `packages/cli/src/workflow/generate-reference-workflow.ts` — generateReferenceWorkflow (Task 4)
  - Import: `packages/cli/src/skills/templates/index.ts` — ALL_SKILL_TEMPLATES (Task 7)
  - Import: `packages/cli/src/skills/skill-writer.ts` — writeAllSkills (Task 3)
  - Test: `packages/cli/src/commands/init.test.ts` — keep the existing 3 tests + add new integration tests

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/commands/init.test.ts` passes (existing + new)
  - [ ] The existing 3 tests pass without changes
  - [ ] Non-interactive init run → generates context.yaml + reference-workflow.md + 6 skills + WORKFLOW.md
  - [ ] `--skip-skills` flag → skill files not generated, everything else generated
  - [ ] `--skip-context` flag → context.yaml not generated, everything else generated
  - [ ] context.yaml includes statusField.id, option.id (field ID plumbing verified)
  - [ ] Existing skill files are skipped when present (re-run idempotency)
  - [ ] Full `pnpm --filter @gh-symphony/cli test` passes
  - [ ] `pnpm typecheck && pnpm lint && pnpm build` pass

  **QA Scenarios**:

  ```
  Scenario: full ecosystem generation (non-interactive)
    Tool: Bash
    Steps: temp configDir + temp repoDir → runNonInteractive(flags, options) with mock fetch
    Expected: WORKFLOW.md, .gh-symphony/context.yaml, .gh-symphony/reference-workflow.md exist in repoDir. 6 skills exist in .claude/skills/ or .codex/skills/.
    Evidence: .sisyphus/evidence/task-8-full-ecosystem.txt

  Scenario: --skip-skills flag
    Tool: Bash
    Steps: run with --skip-skills added
    Expected: skill directory not generated; context.yaml and WORKFLOW.md are generated
    Evidence: .sisyphus/evidence/task-8-skip-skills.txt

  Scenario: re-run idempotency
    Tool: Bash
    Steps: generate the ecosystem → modify one skill file → re-run init
    Expected: context.yaml refreshed, the modified skill file preserved (not overwritten)
    Evidence: .sisyphus/evidence/task-8-idempotency.txt

  Scenario: field ID plumbing
    Tool: Bash
    Steps: mock ProjectDetail with field IDs → init → parse context.yaml → verify the IDs exist
    Expected: status_field.id and status_field.columns[].id all non-empty
    Evidence: .sisyphus/evidence/task-8-field-ids.txt
  ```

  **Commit**: YES | Message: `feat(cli): wire workflow ecosystem into init command` | Files: [packages/cli/src/commands/init.ts, packages/cli/src/commands/init.test.ts]

## Final Verification Wave (4 parallel agents, ALL must APPROVE)

- [x] F1. Plan Compliance Audit — oracle

  **What to do**: Verify compliance with the Must NOT Have rules
  **Recommended Agent Profile**:
  - Category: `deep` — Reason: full codebase scan required
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: verify no changes to the core/orchestrator/worker packages
    Tool: Bash
    Steps: git diff --name-only HEAD~8..HEAD | grep -E '^packages/(core|orchestrator|worker)/'
    Expected: no output (0 lines)
    Evidence: .sisyphus/evidence/f1-no-core-changes.txt

  Scenario: verify no new {{variable}} patterns
    Tool: ast-grep
    Steps: ast_grep_search(pattern="renderPrompt($TEMPLATE, $VARS)", lang="typescript") → cross-check against the PromptVariables type
    Expected: variables used in renderPrompt calls are only the existing 8 (issue.* + attempt)
    Evidence: .sisyphus/evidence/f1-no-new-vars.txt

  Scenario: no tokens included in context.yaml
    Tool: Bash (grep)
    Steps: grep -ri "token\|secret\|password\|ghp_\|gho_" packages/cli/src/context/
    Expected: the context.yaml generation code writes no token-related values
    Evidence: .sisyphus/evidence/f1-no-secrets.txt
  ```

- [x] F2. Code Quality Review — unspecified-high

  **What to do**: Verify code quality + consistency with existing patterns
  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: quality verification across the whole CLI package
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: TypeScript + Lint + Build
    Tool: Bash
    Steps: pnpm typecheck && pnpm lint && pnpm build
    Expected: exit code 0, no errors
    Evidence: .sisyphus/evidence/f2-build-pass.txt

  Scenario: full test suite
    Tool: Bash
    Steps: pnpm --filter @gh-symphony/cli test
    Expected: all tests pass (existing + new)
    Evidence: .sisyphus/evidence/f2-test-pass.txt

  Scenario: atomic write pattern compliance
    Tool: ast-grep
    Steps: search for writeFile calls in the new files → check whether the tmp+rename pattern is used
    Expected: no direct writeFile(final path) — all use tmp+rename or existing utilities
    Evidence: .sisyphus/evidence/f2-atomic-write.txt
  ```

- [x] F3. Integration QA — unspecified-high

  **What to do**: Verify the full ecosystem by simulating an actual init run
  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: integration-test-level verification
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: verify all ecosystem files exist
    Tool: Bash
    Steps: npx vitest run packages/cli/src/commands/init.test.ts → verify the file tree of the temp dir created by the integration test
    Expected: WORKFLOW.md, .gh-symphony/context.yaml, .gh-symphony/reference-workflow.md, and the 6 directories under .claude/skills/ or .codex/skills/ exist
    Evidence: .sisyphus/evidence/f3-ecosystem-files.txt

  Scenario: WORKFLOW.md round-trip (strict mode)
    Tool: Bash
    Steps: run the test that calls parseWorkflowMarkdown() on the generated WORKFLOW.md → renderPrompt(promptTemplate, mockVars, {strict:true})
    Expected: no throw
    Evidence: .sisyphus/evidence/f3-roundtrip.txt

  Scenario: idempotency verification
    Tool: Bash
    Steps: run init twice → after the second run, check the skill file contents are identical to the first (not overwritten)
    Expected: the skipped array includes the 6 skills
    Evidence: .sisyphus/evidence/f3-idempotency.txt
  ```

- [x] F4. Scope Fidelity Check — deep

  **What to do**: Verify that the brainstorming session decisions are accurately reflected in the implementation
  **Recommended Agent Profile**:
  - Category: `deep` — Reason: verifying the implementation mapping against requirements
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: per-runtime skill directory separation
    Tool: Bash
    Steps: init with the codex runtime → verify .codex/skills/ exists + .claude/skills/ does not. Init with claude-code → verify the reverse.
    Expected: only the selected runtime's directory exists
    Evidence: .sisyphus/evidence/f4-runtime-separation.txt

  Scenario: context.yaml field ID inclusion
    Tool: Bash
    Steps: extract the status_field.id, status_field.columns[].id values from the generated context.yaml
    Expected: all IDs are non-empty strings
    Evidence: .sisyphus/evidence/f4-field-ids.txt

  Scenario: custom runtime skill skip
    Tool: Bash
    Steps: init with the custom runtime → verify the skill directory does not exist + context.yaml does exist
    Expected: neither .claude/skills/ nor .codex/skills/ exists, .gh-symphony/context.yaml exists
    Evidence: .sisyphus/evidence/f4-custom-skip.txt
  ```

## Commit Strategy

```
Commit 1: feat(cli): add environment detection module
Commit 2: feat(cli): add context.yaml schema and generator
Commit 3: feat(cli): add skill writer infrastructure
Commit 4: feat(cli): add reference workflow generator
Commit 5: feat(cli): enhance WORKFLOW.md with richer prompt body
Commit 6: feat(cli): add core skill templates (gh-symphony, gh-project)
Commit 7: feat(cli): add workflow skill templates (commit, push, pull, land)
Commit 8: feat(cli): wire workflow ecosystem into init command
```

## Success Criteria

- On init run, all ecosystem files are generated (context.yaml, reference-workflow.md, WORKFLOW.md, 6 skills)
- The generated WORKFLOW.md parses cleanly with the core parser
- The generated WORKFLOW.md passes renderPrompt strict mode
- context.yaml includes field IDs + option IDs
- Environment detection: distinguishes pnpm/npm/yarn/bun + extracts the test command
- Skill files are generated in the correct per-runtime directory
- Init re-runs are idempotent (context.yaml refreshed, skills preserved)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` all pass

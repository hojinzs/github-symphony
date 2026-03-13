# WORKFLOW Spec Conformance Migration

## TL;DR

> **Summary**: `gh-symphony`의 `WORKFLOW.md` 계약을 upstream Symphony SPEC의 repository contract에 맞춘다. 핵심은 worker를 제거하는 것이 아니라, `WORKFLOW.md` schema/generator/parser/validation/loading을 `tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex` 중심으로 재정렬하고, repo root `WORKFLOW.md`가 없거나 core schema가 invalid면 orchestrator와 worker가 모두 거부하도록 만드는 것이다.
> **Deliverables**: spec-conformant parser/config, spec-conformant `gh-symphony init` generator, strict repo-owned workflow gating, extension policy, hook semantics alignment, migration tests/docs.
> **Effort**: Large
> **Parallel**: Limited — foundation first, then enforcement and docs
> **Critical Path**: Core Contract/Parser -> Init Generator -> Orchestrator/Worker Rejection -> Migration Cleanup

## Context

### Original Request

`gh-symphony init`이 만들어내는 `WORKFLOW.md`를 upstream Symphony SPEC과 upstream `WORKFLOW.md` 의미에 맞추고 싶다. 또한 orchestrator와 worker가 `WORKFLOW.md`가 없거나 규격에 맞지 않으면 실행을 거부해야 한다. 단, extension은 SPEC이 허용하는 범위 내에서 허용한다.

### Corrected Assumptions

1. **맞음**: `WORKFLOW.md`는 repo-owned canonical contract여야 한다.
2. **맞음**: missing/invalid `WORKFLOW.md`는 dispatch/run gate에서 거부해야 한다.
3. **정정 필요**: extension은 금지 대상이 아니라 허용 대상이다. SPEC은 unknown keys를 forward compatibility를 위해 허용한다.
4. **정정 필요**: worker 중간 레이어는 자체로 SPEC 위반이 아니다. 현재 주요 불일치는 process topology보다 `WORKFLOW.md` schema mismatch다.
5. **정정 필요**: `codex.command`는 raw command여야 하며, `bash -lc` wrapping은 runtime 책임이다. `WORKFLOW.md` 안에 `bash -lc codex app-server`를 저장하면 upstream 의미와 다시 어긋난다.

### Current Problem Statement

현재 구현은 다음과 같은 GitHub Symphony 전용 schema를 canonical처럼 사용한다.

- top-level: `github_project_id`, `allowed_repositories`, `lifecycle`, `runtime`, `scheduler`, `retry`, `max_concurrent_by_state`
- runtime command: `runtime.agent_command`
- polling: `scheduler.poll_interval_ms`
- states: `lifecycle.active_states`, `lifecycle.terminal_states`
- fallback behavior: repo `WORKFLOW.md`가 없으면 tenant `WORKFLOW.md`, 그것도 없으면 hardcoded default

이 구조는 upstream SPEC의 Section 5 repository contract와 호환되지 않는다.

## Work Objectives

### Core Objective

`gh-symphony`가 upstream Symphony SPEC의 repository contract를 primary contract로 사용하도록 재정렬한다. repository root `WORKFLOW.md`를 strict source of truth로 사용하고, orchestrator/worker 모두 core schema invalid 상태를 거부한다.

### Deliverables

1. SPEC-shaped `WORKFLOW.md` parser and typed config layer
2. SPEC-shaped `gh-symphony init` output
3. GitHub support via documented extension fields, not primary top-level replacements
4. Strict missing/invalid workflow rejection in orchestrator and worker
5. Hook semantics alignment toward inline script + timeout
6. Explicit compatibility mode for legacy workflow parsing, not silent fallback
7. Updated docs/tests reflecting the new contract

### Definition of Done

- `WORKFLOW.md` canonical front matter uses core top-level keys: `tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex`
- `gh-symphony init` emits `codex.command: codex app-server` for Codex runtime
- repo root `WORKFLOW.md` missing -> orchestrator dispatch rejected
- repo root `WORKFLOW.md` invalid core schema -> orchestrator dispatch rejected
- worker startup rejects assigned run when the repository workflow is missing/invalid
- unknown extension keys are tolerated and ignored unless explicitly consumed
- legacy sectioned / old GitHub-specific schema is not silently accepted in strict default mode
- parser, generator, orchestrator, worker tests pass

### Must Have

- SPEC core key validation
- extension tolerance
- GitHub tracker support represented as extension, not top-level contract replacement
- strict repo-owned workflow gating
- raw `codex.command` storage and runtime-side shell wrapping
- migration coverage for missing file, invalid YAML, invalid type, unsupported old schema, extension presence

### Must NOT Have

- worker removal as a prerequisite for conformance
- silent fallback to tenant `WORKFLOW.md` in strict default mode
- hardcoded default workflow treated as dispatch-valid when repo workflow is missing
- `runtime.agent_command` retained as primary canonical field
- path-only hook semantics left undocumented as if they were spec compliant

## Frozen Decisions

These decisions are fixed before Phase 1 begins.

1. **GitHub extension namespace**
   - Use `tracker.kind: github-project`
   - Use `tracker.project_id`, `tracker.state_field`, `tracker.allowed_repositories`, `tracker.blocker_check_states` as documented GitHub tracker extensions
2. **`max_turns` placement**
   - Store as documented extension `agent.max_turns`
3. **Compatibility switch**
   - Use explicit env/option-based compatibility mode only
   - Default behavior is strict SPEC mode
   - Proposed switch names for implementation: parser/loader option plus `SYMPHONY_WORKFLOW_COMPAT_MODE=legacy` for runtime wiring
4. **Tenant fallback disposition**
   - Remove tenant fallback from strict default dispatch/run path
   - If preserved, keep behind explicit compatibility mode only

## Target Contract

### Canonical Core Keys

The new canonical `WORKFLOW.md` front matter must be rooted in:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`

### Extension Policy

- Unknown top-level keys are allowed and ignored by default
- Extensions must not replace or shadow required core keys
- GitHub-specific behavior should live in documented extension fields, preferably under `tracker` when semantically tracker-related
- Internal runtime-only details must not leak into repository contract unless intentionally documented as extensions

### Canonical Runtime Semantics

- `codex.command` stores the raw executable command, for example `codex app-server`
- runtime launches `bash -lc <codex.command>` in the workspace directory
- process topology is implementation-defined; `orchestrator -> worker -> codex` remains allowed

## Mapping Table

### Current -> Target Mapping

| Current field                                    | Target field                             | Status                   | Notes                                                                             |
| ------------------------------------------------ | ---------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `github_project_id`                              | `tracker.project_id`                     | extension move           | GitHub-specific, keep as documented tracker extension                             |
| `allowed_repositories`                           | `tracker.allowed_repositories`           | extension move           | optional GitHub extension                                                         |
| `lifecycle.state_field`                          | `tracker.state_field`                    | extension move           | GitHub Project status field name                                                  |
| `lifecycle.active_states`                        | `tracker.active_states`                  | core move                | primary dispatch gating states                                                    |
| `lifecycle.terminal_states`                      | `tracker.terminal_states`                | core move                | terminal gating states                                                            |
| `lifecycle.blocker_check_states`                 | `tracker.blocker_check_states`           | extension move           | not upstream core                                                                 |
| `runtime.agent_command`                          | `codex.command`                          | core rename/semantic fix | remove embedded `bash -lc` from stored value                                      |
| `runtime.read_timeout_ms`                        | `codex.read_timeout_ms`                  | core move                | direct spec field                                                                 |
| `runtime.turn_timeout_ms`                        | `codex.turn_timeout_ms`                  | core move                | direct spec field                                                                 |
| `runtime.max_turns`                              | `agent.max_turns`                        | extension move           | useful local extension, not core Section 5 key                                    |
| `scheduler.poll_interval_ms`                     | `polling.interval_ms`                    | core move                | direct spec field                                                                 |
| `retry.max_delay_ms`                             | `agent.max_retry_backoff_ms`             | core move                | direct spec field                                                                 |
| `retry.base_delay_ms`                            | `agent.retry_base_delay_ms` or extension | extension move           | upstream core does not define base delay                                          |
| `max_concurrent_by_state`                        | `agent.max_concurrent_agents_by_state`   | core move                | direct spec field                                                                 |
| tenant runtime workspace root                    | `workspace.root`                         | core move                | must become repository contract input                                             |
| `hooks.after_create: hooks/after_create.sh` path | `hooks.after_create` inline script       | semantic change          | runtime may support migration helper, but canonical meaning becomes inline script |

### Current Behaviors -> Target Behaviors

| Current behavior                                              | Target behavior                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| repo workflow missing -> tenant fallback -> hardcoded default | repo workflow missing -> reject dispatch/run                                                        |
| invalid workflow with cached prior config may continue        | future dispatch/run rejected in strict mode; last-known-good may remain observability metadata only |
| legacy sectioned parsing auto-enabled                         | legacy parsing behind explicit compatibility mode only                                              |
| generator outputs GitHub-specific schema                      | generator outputs SPEC core schema + documented GitHub extensions                                   |
| workflow stores `bash -lc codex app-server`                   | workflow stores `codex app-server`                                                                  |

## Validation and Rejection Policy

### Orchestrator Policy

The orchestrator must reject dispatch when any of the following is true:

1. repository root `WORKFLOW.md` is missing
2. YAML front matter is syntactically invalid
3. front matter is not a map/object
4. required core sections are missing for the selected tracker/runtime path
5. required core field values are empty or wrong-typed
6. workflow uses obsolete schema as canonical input in strict mode

Expected behavior:

- reconciliation may continue using current runtime state
- new dispatches are blocked
- error is surfaced in status/observability
- tenant fallback is not used in strict default mode

### Worker Policy

The worker must reject assigned run startup when any of the following is true:

1. assigned repository lacks `WORKFLOW.md`
2. workflow parse/validation fails
3. required core runtime fields are missing after validation
4. runtime launch plan cannot be derived from validated workflow

Expected behavior:

- no Codex process launch
- run marked failed with explicit workflow validation error
- no silent use of env-only `SYMPHONY_AGENT_COMMAND` as canonical fallback

### Loader Policy

- loader may keep last-known-good snapshot for observability/debugging
- loader result must differentiate `load succeeded` vs `fallback snapshot exists`
- strict dispatch/startup gate must not treat `usedLastKnownGood=true` as valid for new work

## File-Level Execution Plan

### Phase 1: Core Contract Refactor

**Goal**: Replace the current typed workflow model with a SPEC-first model.

Files:

- `packages/core/src/workflow/config.ts`
- `packages/core/src/workflow/parser.ts`
- `packages/core/src/workflow/loader.ts`
- `packages/core/src/contracts/status-surface.ts`

Work:

- redefine workflow config types around `tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex`
- add documented GitHub tracker extension types
- separate strict validation errors from compatibility parsing
- remove `DEFAULT_WORKFLOW_DEFINITION` as a dispatch-valid substitute

Tests first:

- parser accepts valid SPEC-shaped workflow
- parser ignores unknown extension keys
- parser rejects missing required core fields
- parser rejects old schema in strict mode
- loader reports validation failures distinctly from cached snapshots
- parser preserves Markdown body as prompt template for valid canonical workflow

Executable QA:

- `npx vitest run packages/core/src/workflow-loader.test.ts`
- add/update `packages/core/src/workflow-loader.test.ts` fixtures for:
  - canonical SPEC workflow success
  - unknown extension tolerance
  - missing core key rejection
  - old schema rejection in strict mode
  - prompt body preserved exactly after front matter parse

### Phase 2: Init / Generator Migration

**Goal**: Make `gh-symphony init` produce canonical upstream-shaped `WORKFLOW.md`.

Files:

- `packages/cli/src/workflow/generate-workflow-md.ts`
- `packages/cli/src/workflow/generate-reference-workflow.ts`
- `packages/cli/src/commands/init.ts`
- `packages/cli/src/commands/init.test.ts`

Work:

- emit `tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex`
- map GitHub inputs into tracker extension fields
- emit raw `codex.command`
- remove schema contamination from tenant runtime/worker command paths
- demote tenant-level generated workflow to compatibility/bootstrap role or remove it from strict flow

Tests first:

- generated file uses canonical keys
- Codex runtime emits `codex.command: codex app-server`
- custom runtime emits raw command under `codex.command`
- no worker bootstrap path can appear in generated repository workflow

Executable QA:

- `npx vitest run packages/cli/src/workflow/generate-workflow-md.test.ts packages/cli/src/commands/init.test.ts`
- update fixtures to assert:
  - `tracker.kind: github-project`
  - `codex.command` stores raw command only
  - prompt body remains parseable and non-empty

### Phase 3: Orchestrator Strict Enforcement

**Goal**: Block new work when repository workflow is missing or invalid.

Files:

- `packages/orchestrator/src/service.ts`
- `packages/orchestrator/src/service.test.ts`
- `packages/orchestrator/src/dispatch.test.ts`

Work:

- stop treating tenant fallback and hardcoded defaults as valid canonical workflow in strict mode
- enforce repo root workflow loading before dispatch
- surface workflow validation errors into run status / observability
- keep any compatibility mode explicit and opt-in

Tests first:

- repo workflow missing -> no dispatch
- repo workflow invalid -> no dispatch
- repo workflow valid with extension keys -> dispatch allowed
- tenant fallback does not mask missing repo workflow in strict mode

Executable QA:

- `npx vitest run packages/orchestrator/src/service.test.ts packages/orchestrator/src/dispatch.test.ts`
- add/update fixtures to assert:
  - missing repo workflow returns suppression/block state
  - invalid repo workflow blocks dispatch even if cache/fallback exists
  - valid workflow with GitHub extensions still dispatches

### Phase 4: Worker Strict Enforcement

**Goal**: Block Codex launch when assigned repo workflow is missing or invalid.

Files:

- `packages/worker/src/index.ts`
- `packages/worker/src/conformance.test.ts`
- `packages/worker/src/state-server.test.ts`

Work:

- validate repo workflow at run startup
- fail before runtime plan / Codex launch on invalid config
- stop depending on env command as sole canonical runtime definition

Tests first:

- missing workflow -> worker startup failure
- invalid core schema -> worker startup failure
- valid workflow -> runtime plan launches normally

Executable QA:

- `npx vitest run packages/worker/src/conformance.test.ts packages/worker/src/state-server.test.ts packages/runtime-codex/src/runtime.test.ts`
- add/update fixtures to assert:
  - valid canonical workflow keeps prompt/body intact
  - valid canonical workflow still yields the same effective worker runtime plan except for raw-command storage

### Phase 5: Hook Semantics Alignment

**Goal**: Align hook meaning with SPEC.

Files:

- `packages/core/src/workspace/hooks.ts`
- related orchestrator/worker call sites and tests

Work:

- support inline script execution for `after_create`, `before_run`, `after_run`, `before_remove`
- add `hooks.timeout_ms`
- decide whether path-based legacy hooks survive only in compatibility mode

Tests first:

- inline hook body executes successfully
- timeout is enforced
- compatibility mode path hook behavior remains isolated if preserved

Executable QA:

- `npx vitest run packages/core/src/workspace/hooks.test.ts`
- add fixtures for inline bash body, timeout case, and compatibility-only path hook case

### Phase 6: Docs and Compatibility Cleanup

**Goal**: Remove ambiguity and document the new primary contract.

Files:

- `README.md`
- `docs/local-development.md`
- `docs/self-hosting.md`
- any old reference workflow docs/tests

Work:

- document strict repo-owned workflow requirement
- document GitHub extension schema explicitly
- document compatibility mode and migration path
- remove examples using `runtime.agent_command`

Executable QA:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- spot-check docs examples by parsing generated sample workflows in updated unit tests

## Verification Strategy

> ZERO HUMAN INTERVENTION — all verification is agent-executed.

- Parser/loader unit tests first
- CLI/init tests second
- orchestrator strict gating tests third
- worker startup rejection tests fourth
- final verification: `pnpm test`, `pnpm typecheck`, `pnpm build`, and targeted package tests if full suite is too slow during iteration

## TDD Plan

1. Write failing parser tests for canonical SPEC shape and old schema rejection
2. Refactor config/parser/loader until green
3. Write failing init generator tests for spec-shaped output
4. Update generator/init until green
5. Write failing orchestrator tests for missing/invalid repo workflow rejection
6. Update orchestrator loading/gating until green
7. Write failing worker tests for startup rejection
8. Update worker startup validation until green
9. Write failing hook semantics tests
10. Refactor hook executor until green
11. Run repo-level verification and update docs

## Atomic Commit Strategy

1. `refactor(core): adopt spec-shaped workflow config and parser`
2. `feat(cli): generate spec-conformant workflow files`
3. `fix(orchestrator): reject missing or invalid repository workflows`
4. `fix(worker): fail assigned runs on invalid workflow contract`
5. `refactor(runtime): align workflow hook semantics with spec`
6. `docs: document spec-conformant workflow contract and extensions`

## Risks / Trade-offs

- **GitHub tracker is not upstream core tracker** -> must remain an extension; avoid pretending it is the upstream Linear schema.
- **Tenant fallback removal changes existing operator behavior** -> strict-by-default is required for conformance, but migration notes are necessary.
- **Last-known-good cache currently softens invalid reloads** -> keep for observability only, not for dispatch validity.
- **Path-based hooks may already be in use** -> require explicit compatibility mode or migration tooling.
- **Old tests/examples rely on `runtime.agent_command`** -> expect broad fixture churn.

## Recommended Next Step

Implement Phase 1 first and treat it as the schema boundary. Do not change orchestrator/worker behavior before the typed contract and parser/validator semantics are stable.

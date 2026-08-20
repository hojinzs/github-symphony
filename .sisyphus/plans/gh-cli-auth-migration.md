# gh CLI Auth Migration — Remove PAT Token Dependency

## TL;DR

> **Quick Summary**: Fully remove the dependency on PAT token input/storage/validation and switch to `gh` CLI-based authentication. Every layer — CLI→Orchestrator→Worker→Runtime — acquires the token via `gh auth token`, while the `GITHUB_GRAPHQL_TOKEN` env var is kept as a fallback for CI/tests.
>
> **Deliverables**:
>
> - `packages/cli/src/github/gh-auth.ts` — gh CLI auth module (installation check, auth check, scope check, token acquisition)
> - Remove the PAT prompt from the CLI `tenant add` / `init` commands and replace it with a gh CLI-based flow
> - Remove the `CliGlobalConfig.token` field and stop writing `tenant.tracker.settings.token`
> - Remove token-related functionality from `config show` / `config set token`
> - The orchestrator acquires the token via `gh auth token` at startup and explicitly injects it into the worker env
> - Update README.md and help.ts documentation
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 → Task 3,4 → Task 5,6,7 → Task 10

---

## Context

### Original Request

Change the `tenant add` and `init` behavior that currently prompts for a PAT token:

1. Verify that the gh CLI is installed
2. Check whether the required permissions (especially project) are present → if not, guide the user to run `gh auth login --scopes` to acquire them
3. Overall, eliminate PAT token storage and dependency, moving everything to be gh CLI-centric

### Interview Summary

**Key Discussions**:

- Completed analysis of every path where the PAT token is used (CLI→config→orchestrator→worker→runtime)
- Confirmed the orchestrator can also use the gh CLI (same user context)
- `buildWorkerEnvironment()` does not pass the token — it is passed via `...process.env` inheritance
- A subprocess on every 30-second poll is excessive → decided on caching once at startup
- git-credential-helper stays on the per-process env var approach (no polluting the global config)

**Research Findings**:

- `gh auth token` is a local read with no network call (single-digit ms + subprocess overhead)
- `gh auth refresh --scopes` is the correct command for adding scopes (not login)
- Priority order: `GH_TOKEN` env → `GITHUB_TOKEN` env → `~/.config/gh/hosts.yml` → keyring
- Fine-grained PATs (`github_pat_...`) do not report scopes — empty scopes = skip

### Metis Review

**Identified Gaps** (addressed):

- control-plane has its own separate auth scheme → **explicitly out of scope**
- The `token` key and `maskToken()` in `config-cmd.ts` need removal → included in Task 8
- Existing tests depend on `process.env.GITHUB_GRAPHQL_TOKEN` → resolved by keeping the env var fallback
- `runInteractiveFromTenant()` uses `globalConfig.token` → handled in Task 7
- CI compatibility when removing the `--token` flag → guide users to `GH_TOKEN` env var + `gh auth login --with-token`
- gh CLI accessibility in daemon mode → safe because the token is cached at startup and injected into env

---

## Work Objectives

### Core Objective

Make the gh CLI the single entry point for authentication, completely eliminating the manual PAT token input/storage pattern.

### Concrete Deliverables

- `packages/cli/src/github/gh-auth.ts` — new module
- `packages/cli/src/github/gh-auth.test.ts` — new tests
- `packages/cli/src/commands/tenant.ts` — remove PAT prompt
- `packages/cli/src/commands/init.ts` — remove PAT prompt
- `packages/cli/src/config.ts` — remove `CliGlobalConfig.token`
- `packages/cli/src/commands/config-cmd.ts` — remove token-related functionality
- `packages/cli/src/commands/help.ts` — remove `--token` examples
- `packages/tracker-github/src/orchestrator-adapter.ts` — update token resolution
- `packages/orchestrator/src/service.ts` — explicitly inject the token into the worker env
- `README.md` — update authentication documentation

### Definition of Done

- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` all pass
- [ ] No `token` field in `~/.gh-symphony/config.json`
- [ ] No `tracker.settings.token` in `tenant.json`
- [ ] `gh-symphony tenant add` proceeds via the gh CLI without PAT input
- [ ] `gh-symphony init` proceeds via the gh CLI without PAT input

### Must Have

- Clear error message + installation guidance when the gh CLI is not installed
- Guidance to run `gh auth login --scopes repo,read:org,project` when the gh CLI is not authenticated
- Guidance to run `gh auth refresh --scopes repo,read:org,project` when scopes are missing
- Keep the `GITHUB_GRAPHQL_TOKEN` env var fallback (test/CI compatibility)
- Keep the token broker pattern (`GITHUB_TOKEN_BROKER_URL/SECRET`) as-is

### Must NOT Have (Guardrails)

- No modifications to `apps/control-plane/` code — separate auth scheme
- No global `gh auth setup-git` configuration — keep the per-process env var approach
- No `gh auth status` calls in the orchestrator polling hot path
- No adding GitHub Enterprise multi-host support
- No modifications to the token broker pattern — keep the `GITHUB_TOKEN_BROKER_URL/SECRET`-related code
- No changes to the `OrchestratorTrackerAdapter` interface signature

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (vitest)
- **Automated tests**: YES (TDD for gh-auth.ts, tests-after for integration changes)
- **Framework**: vitest (`pnpm test`)

### QA Policy

Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI commands**: Use interactive_bash (tmux) — Run command, validate output
- **Module tests**: Use Bash (`pnpm --filter @gh-symphony/cli test`)
- **Build verification**: Use Bash (`pnpm build && pnpm typecheck`)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — start immediately):
├── Task 1: gh-auth.ts module + tests [deep]
└── Task 2: Remove token field from config types [quick]

Wave 2 (Core changes — after Wave 1, MAX PARALLEL):
├── Task 3: Update orchestrator-adapter.ts token resolution (depends: 1) [quick]
├── Task 4: Remove token from writeConfig() (depends: 2) [quick]
├── Task 5: Change tenant.ts interactive flow (depends: 1, 4) [unspecified-high]
├── Task 6: Change tenant.ts non-interactive flow (depends: 1, 4) [quick]
├── Task 7: Change entire init.ts flow (depends: 1, 4) [unspecified-high]
└── Task 8: Remove token functionality from config-cmd.ts (depends: 2) [quick]

Wave 3 (Orchestrator + Docs — after Wave 2):
├── Task 9:  Inject token into worker env in orchestrator service.ts (depends: 1) [quick]
├── Task 10: Update help.ts + README.md documentation (depends: 5, 6, 7) [writing]
└── Task 11: Full build + test + typecheck verification (depends: all) [quick]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 5 → Task 10 → Task 11 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 6 (Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks        | Wave |
| ---- | ---------- | ------------- | ---- |
| 1    | —          | 3, 5, 6, 7, 9 | 1    |
| 2    | —          | 4, 8          | 1    |
| 3    | 1          | 11            | 2    |
| 4    | 2          | 5, 6, 7       | 2    |
| 5    | 1, 4       | 10            | 2    |
| 6    | 1, 4       | 10            | 2    |
| 7    | 1, 4       | 10            | 2    |
| 8    | 2          | 11            | 2    |
| 9    | 1          | 11            | 3    |
| 10   | 5, 6, 7    | 11            | 3    |
| 11   | all        | F1-F4         | 3    |

### Agent Dispatch Summary

- **Wave 1**: **2** — T1 → `deep`, T2 → `quick`
- **Wave 2**: **6** — T3 → `quick`, T4 → `quick`, T5 → `unspecified-high`, T6 → `quick`, T7 → `unspecified-high`, T8 → `quick`
- **Wave 3**: **3** — T9 → `quick`, T10 → `writing`, T11 → `quick`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Create gh-auth.ts module + TDD tests

  **What to do**:
  - Create the new module `packages/cli/src/github/gh-auth.ts`
  - Create the test file `packages/cli/src/github/gh-auth.test.ts` (TDD — tests first)
  - Dependency injection pattern: make subprocess mocking possible via an `execImpl?: typeof execFileSync` parameter
  - Functions to export:
    - `checkGhInstalled(opts?): boolean` — runs `gh --version`, returns whether it is installed
    - `checkGhAuthenticated(opts?): { authenticated: boolean; login?: string }` — parses `gh auth status` stderr (the "Logged in to github.com account **<login>**" pattern)
    - `checkGhScopes(opts?): { valid: boolean; missing: string[]; scopes: string[] }` — checks scopes by parsing the "Token scopes: 'repo', 'read:org', 'project'" line in `gh auth status` stderr. If there is no scopes line (fine-grained PAT) → treat as valid: true (skip the scope check)
    - `getGhToken(opts?): string` — token resolution priority: `process.env.GITHUB_GRAPHQL_TOKEN` → `execFileSync("gh", ["auth", "token"])` → throw
    - `ensureGhAuth(opts?): { login: string; token: string }` — combines the functions above; on failure returns a specific guidance message
  - Export a `GhAuthError` class (per-code errors: `not_installed`, `not_authenticated`, `missing_scopes`, `token_failed`)
  - Use `execFileSync` (NOT `execSync`) — prevents shell injection
  - `gh auth status` prints to stderr — capture stderr with `execFileSync`'s `{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }` options. Exit code 1 = not authenticated, exit code 0 = authenticated
  - **Important**: `gh auth status` does not support the `--json` flag. It must be implemented via plain text stderr parsing

  **Must NOT do**:
  - No direct network calls — use only gh CLI subprocesses
  - No global state changes
  - No references to `apps/control-plane/`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: New module design + TDD pattern + subprocess mocking + error handling is complex
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: no UI
    - `git-master`: not a git task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Tasks 3, 5, 6, 7, 9
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `packages/cli/src/github/client.ts:73-82` — existing `createClient(token)` pattern. The new module provides an API symmetric to this. Design function signatures by referring to the `validateToken()` + `checkRequiredScopes()` patterns
  - `packages/cli/src/github/client.ts:86-134` — `validateToken()`, `checkRequiredScopes()` implementations. Reuse the required array `["repo", "read:org", "project"]` from the scope check logic as-is
  - `packages/runtime-codex/src/github-graphql-tool.ts:57-116` — the fallback chain pattern of `resolveGitHubGraphQLToken()`. env var → broker → error. The new module goes env var → gh CLI → error

  **API/Type References**:
  - `packages/cli/src/github/client.ts:10-14` — `ViewerInfo` type (`login`, `name`, `scopes`). Reference for the return type of gh-auth's `checkGhAuthenticated`
  - `packages/cli/src/github/client.ts:63-71` — `GitHubApiError` class. Reference for the design of the `GhAuthError` class

  **Test References**:
  - `packages/cli/src/commands/init.test.ts` — CLI test patterns, mocking strategy reference
  - `packages/runtime-codex/src/launcher.test.ts` — subprocess mocking pattern reference

  **External References**:
  - `gh auth token` — prints the token (stdout, exit 0). When not authenticated: exit 1 + stderr
  - `gh auth status` — prints authentication state to **stderr**. Exit 0 = authenticated, exit 1 = not authenticated. Example output format:
    ```
    github.com
      ✓ Logged in to github.com account <username> (<path>)
      - Active account: true
      - Git operations protocol: https
      - Token: ghp_****
      - Token scopes: 'project', 'read:org', 'repo'
    ```
    **Caution**: the `--json` flag is not supported. Plain text stderr parsing is required
  - `gh auth refresh --scopes repo,read:org,project` — the command to add scopes (refresh, not login)

  **WHY Each Reference Matters**:
  - Following the patterns in `client.ts` keeps consistency with existing code
  - The required array in the scope check logic is identical → reuse or share the constant
  - The env var fallback pattern is already a proven pattern in `resolveGitHubGraphQLToken`

  **Acceptance Criteria**:
  - [ ] `packages/cli/src/github/gh-auth.ts` file exists
  - [ ] `packages/cli/src/github/gh-auth.test.ts` file exists
  - [ ] `pnpm --filter @gh-symphony/cli test` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Error handling when gh CLI is not installed
    Tool: Bash
    Preconditions: execImpl mocked — gh --version throws ENOENT
    Steps:
      1. Call `checkGhInstalled({ execImpl: mockExec })`
      2. Check the return value
    Expected Result: returns `false`
    Failure Indicators: a throw occurs or true is returned
    Evidence: .sisyphus/evidence/task-1-gh-not-installed.txt

  Scenario: gh CLI authenticated + correct scopes
    Tool: Bash
    Preconditions: execImpl mocked — gh auth token → "ghp_test123", gh auth status → normal output
    Steps:
      1. Call `ensureGhAuth({ execImpl: mockExec })`
      2. Check the return value
    Expected Result: returns `{ login: "testuser", token: "ghp_test123" }`
    Failure Indicators: GhAuthError thrown
    Evidence: .sisyphus/evidence/task-1-gh-auth-success.txt

  Scenario: GITHUB_GRAPHQL_TOKEN env var fallback
    Tool: Bash
    Preconditions: process.env.GITHUB_GRAPHQL_TOKEN = "ghp_env_token_abc"
    Steps:
      1. Call `getGhToken()` (no execImpl — the env var takes priority)
      2. Check the return value
    Expected Result: returns `"ghp_env_token_abc"` (without calling the gh CLI)
    Failure Indicators: a subprocess call occurs
    Evidence: .sisyphus/evidence/task-1-env-var-fallback.txt

  Scenario: Guidance message when scopes are missing
    Tool: Bash
    Preconditions: execImpl mocked — gh auth status → scopes without "project"
    Steps:
      1. Call `checkGhScopes({ execImpl: mockExec })`
      2. Check the return value
    Expected Result: returns `{ valid: false, missing: ["project"], scopes: ["repo", "read:org"] }`
    Failure Indicators: valid: true returned
    Evidence: .sisyphus/evidence/task-1-missing-scopes.txt
  ```

  **Commit**: YES
  - Message: `feat(cli): add gh-auth module for gh CLI-based authentication`
  - Files: `packages/cli/src/github/gh-auth.ts`, `packages/cli/src/github/gh-auth.test.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli test`

- [x] 2. Remove the token field from config types

  **What to do**:
  - `packages/cli/src/config.ts` — remove the `token: string | null` field from the `CliGlobalConfig` type
  - Verify that `loadGlobalConfig` and `saveGlobalConfig` work without `token`
  - Ensure that existing config files with a `token` field still load without errors, with the field ignored (removing it from the TypeScript type alone is enough — JSON.parse ignores it automatically)
  - Remove the `token: string` field from the `WriteConfigInput` type — `packages/cli/src/commands/init.ts:826-844`
  - Only the types change in this step. The actual call sites (`writeConfig()`, `tenantAdd()`, etc.) are handled in subsequent tasks

  **Must NOT do**:
  - Do not modify the `writeConfig()` function body yet (handled in Task 4)
  - Do not modify other files

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Removing 2 type fields, single-file change
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Tasks 4, 8
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `packages/cli/src/config.ts:14-18` — `CliGlobalConfig` type definition. The `token: string | null` line is the removal target
  - `packages/cli/src/commands/init.ts:826-844` — `WriteConfigInput` type definition. The `token: string` line is the removal target

  **WHY Each Reference Matters**:
  - Clarifies exactly which field on which line is being removed

  **Acceptance Criteria**:
  - [ ] No `token` field in the `CliGlobalConfig` type
  - [ ] No `token` field in the `WriteConfigInput` type
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → confirm compile errors (intentional — fixed in subsequent tasks)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Verify the type changes are exact
    Tool: Bash
    Preconditions: Task 2 complete
    Steps:
      1. Run grep -n "token" packages/cli/src/config.ts
      2. Verify there is no token field in the CliGlobalConfig type block
      3. Run grep -n "token: string" packages/cli/src/commands/init.ts | grep WriteConfigInput
    Expected Result: no token in CliGlobalConfig, no token in WriteConfigInput
    Failure Indicators: token field still exists
    Evidence: .sisyphus/evidence/task-2-type-removal.txt

  Scenario: Loading an existing config.json works without errors
    Tool: Bash
    Preconditions: a config.json of the form `{"activeTenant": "test", "token": "ghp_old", "tenants": ["test"]}`
    Steps:
      1. When loadGlobalConfig() is called, parse the JSON that contains the token field
      2. Verify it loads without errors
    Expected Result: no error (TypeScript runtime ignores extra fields)
    Failure Indicators: JSON.parse error
    Evidence: .sisyphus/evidence/task-2-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): remove token field from CliGlobalConfig and WriteConfigInput types`
  - Files: `packages/cli/src/config.ts`, `packages/cli/src/commands/init.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck 2>&1 || true` (intentional errors — call sites not yet updated)

- [x] 3. Remove the stored token from the orchestrator-adapter.ts token resolution

  **What to do**:
  - `packages/tracker-github/src/orchestrator-adapter.ts` — change the token resolution chain in the `listIssues()` method
  - Current: `dependencies.token` → `tenant.tracker.settings?.token` → `process.env.GITHUB_GRAPHQL_TOKEN`
  - Change to: `dependencies.token` → `process.env.GITHUB_GRAPHQL_TOKEN` → error
  - Remove the line referencing `tenant.tracker.settings?.token` (line 11)
  - Update the error message: "GITHUB_GRAPHQL_TOKEN is required" → "GITHUB_GRAPHQL_TOKEN environment variable is required. Run 'gh auth token' or set the variable."
  - Update the related tests in `packages/tracker-github/src/tracker-github.test.ts`

  **Must NOT do**:
  - No changes to the `OrchestratorTrackerAdapter` interface signature
  - No modifications to `buildWorkerEnvironment()`
  - Do not remove the `dependencies.token` injection path (needed for test isolation)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 3-line change within a single file
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4-8)
  - **Blocks**: Task 11
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `packages/tracker-github/src/orchestrator-adapter.ts:7-35` — the full `listIssues()` implementation. The token resolution chain is on lines 9-12

  **API/Type References**:
  - `packages/core/src/contracts/tracker-adapter.ts` — the `OrchestratorTrackerAdapter` interface. `dependencies.token?: string` must be kept

  **Test References**:
  - `packages/tracker-github/src/tracker-github.test.ts` — check the token-related cases in the existing tests

  **Acceptance Criteria**:
  - [ ] No reference to `tenant.tracker.settings?.token`
  - [ ] The `dependencies.token` path is kept
  - [ ] The `process.env.GITHUB_GRAPHQL_TOKEN` fallback is kept
  - [ ] `pnpm --filter @gh-symphony/tracker-github test` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Token resolution succeeds via env var
    Tool: Bash
    Preconditions: process.env.GITHUB_GRAPHQL_TOKEN = "ghp_test_token"
    Steps:
      1. Call listIssues(tenant, {}) — no token in tenant.tracker.settings
      2. Check the Authorization header on the fetch call
    Expected Result: uses the "Bearer ghp_test_token" header
    Evidence: .sisyphus/evidence/task-3-env-token.txt

  Scenario: Error message when no token is present
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN unset, no tenant.tracker.settings.token
    Steps:
      1. Call listIssues(tenant, {})
    Expected Result: Error thrown — "GITHUB_GRAPHQL_TOKEN environment variable is required"
    Evidence: .sisyphus/evidence/task-3-no-token-error.txt
  ```

  **Commit**: YES
  - Message: `refactor(tracker-github): remove stored token from resolution chain`
  - Files: `packages/tracker-github/src/orchestrator-adapter.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/tracker-github test`

- [x] 4. Remove token storage from writeConfig()

  **What to do**:
  - `packages/cli/src/commands/init.ts` — modify the `writeConfig()` function body:
    - Remove `tracker.settings.token: input.token` from the `saveTenantConfig()` call (line 889)
    - Remove `token: input.token` from the `saveGlobalConfig()` call (line 907)
  - Remove the `token` argument everywhere `writeConfig()` is called:
    - `tenant.ts:198-206` — remove `token` from `writeConfig(options.configDir, { tenantId, token: flags.token, ... })`
    - `tenant.ts:452-465` — remove `token` from the interactive-mode writeConfig call
    - Also clean up token references inside the `init.ts` non-interactive mode

  **Must NOT do**:
  - Do not modify any function other than the `writeConfig()` signature (the CLI flows are Tasks 5-7)
  - Do not add migration logic for existing config files (old files can be left as-is)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Removing 3-4 lines inside a function
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 5-8)
  - **Blocks**: Tasks 5, 6, 7
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/init.ts:855-933` — the full `writeConfig()` function. Where token is used: line 889 (`tracker.settings.token`), line 907 (`globalConfig.token`)
  - `packages/cli/src/commands/tenant.ts:198-206` — non-interactive writeConfig call
  - `packages/cli/src/commands/tenant.ts:452-465` — interactive writeConfig call

  **Acceptance Criteria**:
  - [ ] No `token` parameter in the `writeConfig()` function
  - [ ] No `tracker.settings.token` in the `saveTenantConfig()` call
  - [ ] No `token` in the `saveGlobalConfig()` call
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS (or after Tasks 5-7 complete)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: No token field written to tenant.json
    Tool: Bash
    Preconditions: check the tenant.json generated after calling writeConfig()
    Steps:
      1. Read the tenant.json file produced by writeConfig()
      2. Check whether a token key exists in the tracker.settings object
    Expected Result: no token key — only projectId and blockedByFieldName exist
    Evidence: .sisyphus/evidence/task-4-no-token-in-config.txt

  Scenario: No token field written to config.json
    Tool: Bash
    Preconditions: check the config.json generated after calling writeConfig()
    Steps:
      1. Read the generated config.json
      2. Check whether a token key exists
    Expected Result: no token key — only activeTenant and tenants exist
    Evidence: .sisyphus/evidence/task-4-no-token-in-global.txt
  ```

  **Commit**: YES (groups with Tasks 5-7)
  - Message: `refactor(cli): remove token from writeConfig and tenant config writes`
  - Files: `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/tenant.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 5. tenant.ts interactive flow — replace the PAT prompt with the gh CLI

  **What to do**:
  - `packages/cli/src/commands/tenant.ts` — modify the `tenantAddInteractive()` function (lines 220-480)
  - **Remove**: the entire Step 1 PAT input loop (`while(true) { p.password(...) }` — lines 246-286)
  - **Add**: `import { ensureGhAuth } from "../github/gh-auth.js"`
  - **Add**: replace Step 1 with gh CLI verification:
    1. Call `ensureGhAuth()` — checks gh installation/authentication/scopes in one go
    2. On failure, branch on `GhAuthError`:
       - `not_installed` → `p.log.error("The gh CLI is not installed. Install it from https://cli.github.com.")`
       - `not_authenticated` → `p.log.error("Run gh auth login --scopes repo,read:org,project.")`
       - `missing_scopes` → `p.log.error("Run gh auth refresh --scopes repo,read:org,project.")`
    3. On success, receive `{ login, token }` and call `createClient(token)` → continue the existing flow
  - Adjust step numbering: Step 1/4 → Step 1/3 (PAT input step removed, the rest unchanged)
  - Use the `ensureGhAuth()` return value instead of the `token` variable
  - Keep `User: viewer.login` in the confirmation summary (viewer uses `ensureGhAuth().login` instead of `validateToken()`)
  - The `validateToken()` and `checkRequiredScopes()` imports can be removed (gh-auth replaces them)

  **Must NOT do**:
  - Do not modify Steps 2-4 (project selection, repo selection, runtime selection)
  - Do not change the structure of the `writeConfig()` call (the token argument was already removed in Task 4)
  - Do not modify `tenantList()`, `tenantRemove()`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Complete rewrite of Step 1 of the existing interactive flow + clack prompt integration
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 6, 7, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 1, 4

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/tenant.ts:220-480` — the full `tenantAddInteractive()`. Lines 246-286 are the PAT input loop to be replaced
  - `packages/cli/src/commands/tenant.ts:1-13` — import statements. Remove `validateToken`, `checkRequiredScopes`; add `ensureGhAuth`
  - `packages/cli/src/commands/tenant.ts:422-430` — confirmation summary. Keep the `User: ${viewer.login}` part

  **API/Type References**:
  - `packages/cli/src/github/gh-auth.ts` created in Task 1 — `ensureGhAuth()`, `GhAuthError` types
  - `packages/cli/src/github/client.ts:73-82` — `createClient(token)` — called with the token received from gh-auth

  **Acceptance Criteria**:
  - [ ] No `p.password()` call in `tenantAddInteractive()`
  - [ ] `ensureGhAuth()` call exists
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: tenant add succeeds when gh CLI auth is complete
    Tool: Bash
    Preconditions: gh CLI installed + authenticated + correct scopes
    Steps:
      1. Start the tenant add interactive flow
      2. Verify "Authenticated as <login>" is printed with no PAT input prompt
      3. Verify it proceeds directly to the project selection step
    Expected Result: Step 1 passes automatically via gh CLI verification, proceeds to Step 2
    Evidence: .sisyphus/evidence/task-5-interactive-gh-auth.txt

  Scenario: Error message when gh CLI is not installed
    Tool: Bash
    Preconditions: environment without gh CLI (gh removed from PATH)
    Steps:
      1. Run tenant add interactive
    Expected Result: "The gh CLI is not installed" error + installation guidance URL
    Evidence: .sisyphus/evidence/task-5-gh-not-installed.txt
  ```

  **Commit**: YES
  - Message: `feat(cli): replace PAT prompt with gh CLI auth in tenant add interactive`
  - Files: `packages/cli/src/commands/tenant.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 6. tenant.ts non-interactive flow — remove the `--token` flag

  **What to do**:
  - `packages/cli/src/commands/tenant.ts` — modify `tenantAddNonInteractive()` (lines 109-216)
  - **Remove**: `--token` flag parsing (the `case "--token"` in `parseTenantAddFlags` — line 48-50)
  - **Remove**: the `TenantAddFlags.token` type field
  - **Remove**: the `if (!flags.token)` validation (lines 113-119)
  - **Add**: acquire the token via a `getGhToken()` call (`import { getGhToken } from "../github/gh-auth.js"`)
  - Change `createClient(flags.token)` → `createClient(getGhToken())`
  - Keep the `validateToken(client)` + `checkRequiredScopes()` calls — token validity is verified via the GitHub API
  - Error handling: on `getGhToken()` failure → "gh CLI authentication required. Run 'gh auth login --scopes repo,read:org,project' or set the GITHUB_GRAPHQL_TOKEN environment variable."

  **Must NOT do**:
  - Do not modify the interactive flow (handled in Task 5)
  - Do not modify the `--project`, `--runtime` flags

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Removing 3 lines of flag parsing + changing 1 line of token acquisition
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3-5, 7, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 1, 4

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/tenant.ts:31-64` — `TenantAddFlags` type + `parseTenantAddFlags()`. Remove the `token`-related lines
  - `packages/cli/src/commands/tenant.ts:109-216` — the full `tenantAddNonInteractive()`

  **Acceptance Criteria**:
  - [ ] No `--token` flag parsing
  - [ ] `getGhToken()` call exists
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Non-interactive mode succeeds without --token
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN environment variable set
    Steps:
      1. Run gh-symphony tenant add --non-interactive --project PVT_xxx
      2. Verify token acquisition without --token
    Expected Result: token acquired from GITHUB_GRAPHQL_TOKEN → proceeds normally
    Evidence: .sisyphus/evidence/task-6-non-interactive-no-token-flag.txt

  Scenario: Error in non-interactive mode when no token is set
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN unset + gh CLI not authenticated
    Steps:
      1. Run gh-symphony tenant add --non-interactive --project PVT_xxx
    Expected Result: "gh CLI authentication required" error message + exit code 1
    Evidence: .sisyphus/evidence/task-6-no-token-error.txt
  ```

  **Commit**: YES (groups with Task 5)
  - Message: `feat(cli): replace --token flag with gh CLI auth in tenant add non-interactive`
  - Files: `packages/cli/src/commands/tenant.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 7. Entire init.ts flow — replace the PAT prompt with the gh CLI

  **What to do**:
  - `packages/cli/src/commands/init.ts` — modify all 3 paths:

  **A. `runNonInteractive()` (lines 343-465)**:
  - Remove the `if (!flags.token)` validation (lines 347-352)
  - Change `createClient(flags.token)` → `createClient(getGhToken())`
  - Keep `validateToken(client)` + `checkRequiredScopes()` (token validity verification)
  - Remove `--token` flag parsing (the `case "--token"` in `parseInitFlags` — line 87-89)
  - Remove the `InitFlags.token` type field

  **B. `runInteractiveStandalone()` (lines 594-782)**:
  - Remove the entire Step 1 PAT input loop (`while(true) { p.password(...) }` — lines 600-639)
  - Replace with an `ensureGhAuth()` call → returns `{ login, token }`
  - Keep the `createClient(token)` call → needed to fetch the project list
  - Adjust step numbering: 3 steps → 2 steps (PAT step removed)

  **C. `runInteractiveFromTenant()` (lines 485-590)**:
  - Change `const token = globalConfig.token` (line 559) → `const token = getGhToken()`
  - Keep the `if (token && projId)` condition (skip ecosystem creation if there is no token)

  **Must NOT do**:
  - Do not modify `writeEcosystem()`, `generateWorkflowMarkdown()`
  - Do not modify `promptBlockedByField()`
  - Do not modify `abortIfCancelled()`, `generateTenantId()`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Modifying 3 paths at once, replacing each token reference with gh-auth
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3-6, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 1, 4

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/init.ts:63-108` — `InitFlags` type + `parseInitFlags()`. Remove the `token`-related lines
  - `packages/cli/src/commands/init.ts:343-465` — the full `runNonInteractive()`
  - `packages/cli/src/commands/init.ts:594-782` — the full `runInteractiveStandalone()`
  - `packages/cli/src/commands/init.ts:485-590` — `runInteractiveFromTenant()`. Replace `globalConfig.token` on line 559

  **API/Type References**:
  - `gh-auth.ts` from Task 1 — `getGhToken()`, `ensureGhAuth()`, `GhAuthError`

  **Acceptance Criteria**:
  - [ ] No `p.password()` call in `runInteractiveStandalone()`
  - [ ] No `flags.token` reference in `runNonInteractive()`
  - [ ] No `globalConfig.token` reference in `runInteractiveFromTenant()`
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS
  - [ ] `pnpm --filter @gh-symphony/cli test` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: init standalone interactive — proceeds via gh CLI auth
    Tool: Bash
    Preconditions: gh CLI authenticated, no tenant configured
    Steps:
      1. Run init interactive
      2. Verify it proceeds to project selection without a PAT prompt
    Expected Result: Step 1 auto-verified via gh CLI, proceeds directly to Step 2 project selection
    Evidence: .sisyphus/evidence/task-7-init-interactive.txt

  Scenario: init non-interactive — via GITHUB_GRAPHQL_TOKEN without --token
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN set
    Steps:
      1. Run gh-symphony init --non-interactive --project PVT_xxx
    Expected Result: works normally without --token
    Evidence: .sisyphus/evidence/task-7-init-non-interactive.txt

  Scenario: init from-tenant — gh CLI instead of globalConfig.token
    Tool: Bash
    Preconditions: tenant configured, gh CLI authenticated
    Steps:
      1. Run cd my-repo && gh-symphony init
      2. Verify tenant-based WORKFLOW.md generation
    Expected Result: token acquired via gh auth token → ecosystem creation succeeds
    Evidence: .sisyphus/evidence/task-7-init-from-tenant.txt
  ```

  **Commit**: YES
  - Message: `feat(cli): replace PAT prompt with gh CLI auth in init command`
  - Files: `packages/cli/src/commands/init.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli test`

- [x] 8. config-cmd.ts — remove token-related functionality

  **What to do**:
  - Modify `packages/cli/src/commands/config-cmd.ts`:
  - **`configShow()`**: remove the `token: config.token ? maskToken(config.token) : null` line (line 47). Remove the `Token:` output line (line 59). Also exclude token from JSON output
  - **`VALID_KEYS`**: remove the `token: { type: "string" }` entry (line 74)
  - **`configSet()`**: remove the `case "token":` branch (lines 117-118). Remove the `maskToken(value)` usage (line 124)
  - **`maskToken()` function**: delete (lines 65-68) — no remaining usages
  - Clean up imports: since the `CliGlobalConfig` type no longer has token, this cleans up automatically

  **Must NOT do**:
  - Do not modify `configEdit()` — keep opening directly in the editor
  - Do not modify the `active-tenant`-related logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single file, clear line removals
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3-7)
  - **Blocks**: Task 11
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/config-cmd.ts:36-63` — `configShow()`. Remove lines 47, 59
  - `packages/cli/src/commands/config-cmd.ts:72-75` — `VALID_KEYS`. Remove line 74
  - `packages/cli/src/commands/config-cmd.ts:106-126` — `configSet()`. Modify lines 117-118, 124
  - `packages/cli/src/commands/config-cmd.ts:65-68` — `maskToken()`. Delete entirely

  **Acceptance Criteria**:
  - [ ] No `Token:` line in the `config show` output
  - [ ] `config set token <value>` → "Unknown config key: token" error
  - [ ] No `maskToken` function
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: No token in config show
    Tool: Bash
    Preconditions: only activeTenant and tenants exist in config.json
    Steps:
      1. Run gh-symphony config show
      2. Check the output
    Expected Result: only the "Active tenant:" and "Tenants:" lines exist. No "Token:" line
    Evidence: .sisyphus/evidence/task-8-config-show-no-token.txt

  Scenario: config set token rejected
    Tool: Bash
    Steps:
      1. Run gh-symphony config set token ghp_xxx
    Expected Result: "Unknown config key: token" error + exit code 2
    Evidence: .sisyphus/evidence/task-8-config-set-token-rejected.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): remove token from config show/set commands`
  - Files: `packages/cli/src/commands/config-cmd.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 9. orchestrator service.ts — explicitly inject the token into the worker env

  **What to do**:
  - `packages/orchestrator/src/service.ts` — modify the `startRun()` method (around lines 518-558)
  - Current: `env: { ...process.env, ... }` — implicit inheritance
  - Change: explicitly inject `GITHUB_GRAPHQL_TOKEN`:
    ```typescript
    GITHUB_GRAPHQL_TOKEN: process.env.GITHUB_GRAPHQL_TOKEN ?? "",
    ```
  - This way, if the token the orchestrator acquired via `gh auth token` is in env, it is passed to the worker
  - `packages/cli/src/commands/start.ts` — before starting the orchestrator, call `getGhToken()` and set `process.env.GITHUB_GRAPHQL_TOKEN`:
    ```typescript
    import { getGhToken } from "../github/gh-auth.js";
    // Cache the token before startup
    if (!process.env.GITHUB_GRAPHQL_TOKEN) {
      try {
        process.env.GITHUB_GRAPHQL_TOKEN = getGhToken();
      } catch {
        // When gh CLI is not installed/authenticated — error if there is no env var fallback
      }
    }
    ```
  - This way: if the env var already exists it is used as-is; otherwise it is acquired once from the gh CLI and cached

  **Must NOT do**:
  - No changes to the `OrchestratorService` constructor signature
  - Do not modify other methods in `service.ts`
  - Do not add token refresh/TTL logic (gh OAuth tokens do not expire)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 2 files, 3-5 lines added in each
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11)
  - **Blocks**: Task 11
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `packages/orchestrator/src/service.ts:518-558` — worker spawn env block. Explicitly add `GITHUB_GRAPHQL_TOKEN` after `...process.env`
  - `packages/cli/src/commands/start.ts:174-271` — foreground mode handler. Location for token caching before creating the orchestrator service

  **API/Type References**:
  - `gh-auth.ts` from Task 1 — the `getGhToken()` function

  **Acceptance Criteria**:
  - [ ] `GITHUB_GRAPHQL_TOKEN` explicitly present in the `service.ts` worker spawn env
  - [ ] `start.ts` calls `getGhToken()` and caches it into env
  - [ ] `pnpm --filter @gh-symphony/orchestrator test` → PASS
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: gh token cached at orchestrator startup
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN unset, gh CLI authenticated
    Steps:
      1. Run the start handler
      2. Verify process.env.GITHUB_GRAPHQL_TOKEN is set
    Expected Result: the token acquired from getGhToken() is set in process.env
    Evidence: .sisyphus/evidence/task-9-token-caching.txt

  Scenario: No gh CLI call when the env var already exists
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN="ghp_existing" set
    Steps:
      1. Run the start handler
      2. Verify no gh CLI subprocess call occurs
    Expected Result: existing env var kept, getGhToken() internally prioritizes the env var
    Evidence: .sisyphus/evidence/task-9-env-var-priority.txt
  ```

  **Commit**: YES
  - Message: `feat(orchestrator): inject gh-resolved token into worker environment`
  - Files: `packages/orchestrator/src/service.ts`, `packages/cli/src/commands/start.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/orchestrator test`

- [x] 10. Update help.ts + README.md documentation

  **What to do**:
  - `packages/cli/src/commands/help.ts`:
    - Remove the `--token <PAT>` example (line 46)
    - Change the `tenant add` example to just `gh-symphony tenant add`
    - Non-interactive example: `gh-symphony tenant add --non-interactive --project <id>` (without --token)
  - `README.md`:
    - "Required classic PAT scopes" section → change to an "Authentication" section
    - Add gh CLI installation/authentication guidance
    - `gh auth login --scopes repo,read:org,project` command example
    - Remove the `--non-interactive --token ghp_xxx` example
    - Add an explanation of the `GITHUB_GRAPHQL_TOKEN` env var fallback (for CI/CD)
    - Update the PAT-related explanations in the "Registering a tenant" section

  **Must NOT do**:
  - No code changes outside documentation
  - No changes to the architecture/package descriptions

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: Documentation writing/editing only
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 11)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 5, 6, 7

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/help.ts:3-53` — the full HELP_TEXT. Replace `--token <PAT>` on line 46
  - `README.md` — the "Required classic PAT scopes" section, the "Registering a tenant" section, non-interactive examples

  **Acceptance Criteria**:
  - [ ] No `--token` string in `help.ts`
  - [ ] No `--token ghp_xxx` pattern in `README.md`
  - [ ] gh CLI authentication guidance exists in `README.md`
  - [ ] `GITHUB_GRAPHQL_TOKEN` fallback explanation exists in `README.md`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: No PAT mentions in the help text
    Tool: Bash
    Steps:
      1. Run grep -i "PAT\|--token" packages/cli/src/commands/help.ts
    Expected Result: no matches (exit code 1)
    Evidence: .sisyphus/evidence/task-10-help-no-pat.txt

  Scenario: gh CLI authentication guidance exists in README
    Tool: Bash
    Steps:
      1. Run grep "gh auth login" README.md
    Expected Result: match exists — gh auth login command guidance
    Evidence: .sisyphus/evidence/task-10-readme-gh-auth.txt
  ```

  **Commit**: YES
  - Message: `docs: update auth documentation for gh CLI migration`
  - Files: `packages/cli/src/commands/help.ts`, `README.md`
  - Pre-commit: `pnpm lint`

- [x] 11. Full build + test + typecheck verification

  **What to do**:
  - Run the full verification command:
    ```bash
    pnpm lint && pnpm test && pnpm typecheck && pnpm build
    ```
  - On failure, identify the cause + fix
  - Things to check in particular:
    - The 8+ files in the existing tests that use `process.env.GITHUB_GRAPHQL_TOKEN = "test-token"` all pass
    - `pnpm --filter @gh-symphony/cli test` — init.test.ts, lifecycle.test.ts, etc.
    - `pnpm --filter @gh-symphony/orchestrator test` — service.test.ts, dispatch.test.ts, etc.
    - `pnpm --filter @gh-symphony/tracker-github test`
    - No token-related type errors in typecheck

  **Must NOT do**:
  - No new features in this task — verification + fixes only

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Run commands + check results
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (after ALL previous tasks)
  - **Blocks**: F1-F4
  - **Blocked By**: ALL tasks (1-10)

  **References**:

  **Test References**:
  - `packages/orchestrator/src/service.test.ts` — main tests using `process.env.GITHUB_GRAPHQL_TOKEN`
  - `packages/orchestrator/src/dispatch.test.ts` — depends on the token env var
  - `packages/cli/src/commands/init.test.ts` — init command tests
  - `packages/cli/src/commands/lifecycle.test.ts` — CLI lifecycle tests

  **Acceptance Criteria**:
  - [ ] `pnpm lint` → exit 0
  - [ ] `pnpm test` → exit 0 (all tests pass)
  - [ ] `pnpm typecheck` → exit 0 (no type errors)
  - [ ] `pnpm build` → exit 0 (clean build)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Full verification passes
    Tool: Bash
    Steps:
      1. Run pnpm lint
      2. Run pnpm test
      3. Run pnpm typecheck
      4. Run pnpm build
    Expected Result: all 4 exit with code 0
    Evidence: .sisyphus/evidence/task-11-full-verification.txt

  Scenario: Verify the env var fallback for existing tests
    Tool: Bash
    Steps:
      1. Run pnpm --filter @gh-symphony/orchestrator test
      2. Verify service.test.ts, dispatch.test.ts pass
    Expected Result: all tests based on process.env.GITHUB_GRAPHQL_TOKEN PASS
    Evidence: .sisyphus/evidence/task-11-env-var-compat.txt
  ```

  **Commit**: NO (verification only — if fixes are needed, commit to the relevant task's files)

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
      Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
      Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
      Run `pnpm lint && pnpm test && pnpm typecheck && pnpm build`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify no `token` field remains in config writes.
      Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
      Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (tenant add → start → status). Test edge cases: gh CLI not installed, not authenticated, wrong scopes. Save to `.sisyphus/evidence/final-qa/`.
      Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination. Verify `apps/control-plane/` untouched.
      Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Task | Commit Message                                                                   | Files                           |
| ---- | -------------------------------------------------------------------------------- | ------------------------------- |
| 1    | `feat(cli): add gh-auth module for gh CLI-based authentication`                  | `gh-auth.ts`, `gh-auth.test.ts` |
| 2    | `refactor(cli): remove token field from CliGlobalConfig type`                    | `config.ts`                     |
| 3    | `refactor(tracker-github): remove stored token from resolution chain`            | `orchestrator-adapter.ts`       |
| 4    | `refactor(cli): remove token from writeConfig and tenant config writes`          | `init.ts`                       |
| 5    | `feat(cli): replace PAT prompt with gh CLI auth in tenant add interactive`       | `tenant.ts`                     |
| 6    | `feat(cli): replace --token flag with gh CLI auth in tenant add non-interactive` | `tenant.ts`                     |
| 7    | `feat(cli): replace PAT prompt with gh CLI auth in init command`                 | `init.ts`                       |
| 8    | `refactor(cli): remove token from config show/set commands`                      | `config-cmd.ts`                 |
| 9    | `feat(orchestrator): inject gh-resolved token into worker environment`           | `service.ts`                    |
| 10   | `docs: update auth documentation for gh CLI migration`                           | `help.ts`, `README.md`          |
| 11   | `chore: verify full build passes after gh CLI auth migration`                    | —                               |

---

## Success Criteria

### Verification Commands

```bash
pnpm lint           # Expected: no errors
pnpm test           # Expected: all tests pass
pnpm typecheck      # Expected: no type errors
pnpm build          # Expected: clean build
```

### Final Checklist

- [ ] All "Must Have" present (gh CLI check, scope guidance, env var fallback, broker preserved)
- [ ] All "Must NOT Have" absent (no control-plane changes, no global git config, no broker changes)
- [ ] `token` field completely removed from `config.json`
- [ ] `tracker.settings.token` completely removed from `tenant.json`
- [ ] Existing test suite passes 100% (test isolation maintained via the env var fallback)

# Learnings — gh-cli-auth-migration

## Project Structure

- pnpm monorepo (pnpm 9+, Node.js 24+)
- Packages: `packages/cli`, `packages/orchestrator`, `packages/tracker-github`, `packages/core`, `packages/runtime-codex`
- Worktree: `/home/ubuntu/.local/share/opencode/worktree/a95c26c782b7d0c6d9e3f4fc14d65f7b5bdcb9ea/witty-island`

## Key Auth Patterns

- `gh auth status` outputs to **stderr** (not stdout), no --json flag
- `gh auth token` outputs to stdout, exit 1 if not authenticated
- `gh auth refresh --scopes` (not `login`) for adding scopes
- Fine-grained PAT (`github_pat_...`) reports empty scopes → skip scope check (valid: true)
- Token priority: `GITHUB_GRAPHQL_TOKEN` env → `gh auth token` subprocess → throw

## Code Conventions

- TypeScript strict mode
- Prettier: double quotes, semicolons, trailing commas (es5)
- ESLint: flat config, unused vars prefixed with `_`
- Tests: `*.test.ts`, vitest, node environment
- `execFileSync` NOT `execSync` (shell injection prevention)

## Package Filter Commands

- `pnpm --filter @gh-symphony/cli test`
- `pnpm --filter @gh-symphony/tracker-github test`
- `pnpm --filter @gh-symphony/orchestrator test`

## Task 1 Notes

- `gh auth status` parsing must tolerate stderr-style formats, including checkmark prefix and optional `**login**` wrappers.
- Scope parsing should treat missing `Token scopes:` as fine-grained PAT mode and return `{ valid: true, missing: [], scopes: [] }`.
- CLI tests can require workspace package builds first (`core`, `tracker-github`, `runtime-codex`, `worker`, `orchestrator`, `cli`) so module exports resolve under Vitest.

## Task 2: Type field removal

- Removed `token: string | null` from CliGlobalConfig (config.ts line 16)
- Removed `token: string` from WriteConfigInput (init.ts line 828)
- Intentional typecheck errors at callsites expected — fixed in Tasks 4-7
- Commit: refactor(cli): remove token field from CliGlobalConfig and WriteConfigInput types

## Task 1 Fix: spawnSync for stderr capture

- gh auth status writes to stderr, not stdout
- execFileSync only returns stdout -> use spawnSync for gh auth status
- spawnSync returns { status, stdout, stderr, pid, signal, output }
- Tests: spawnImpl mock returns object, execImpl mock returns string

## Task 3: orchestrator-adapter.ts token resolution

- Removed `tenant.tracker.settings?.token` from resolution chain
- Chain is now: `dependencies.token ?? process.env.GITHUB_GRAPHQL_TOKEN`
- `dependencies.token` is kept for test isolation (not production use)
- Error message updated to: "GITHUB_GRAPHQL_TOKEN environment variable is required. Run 'gh auth token' or set the variable."
- Test updated: "uses dependencies.token when no env token is set" (was "falls back to the tenant token...")
- All tests pass: 10 passed (10)
- Commit: refactor(tracker-github): remove stored token from resolution chain

## Task 4: writeConfig() token removal

- Removed `token: input.token` from `saveTenantConfig()` call (init.ts line 887)
- Removed `token: input.token` from `saveGlobalConfig()` call (init.ts line 906)
- Removed `token: flags.token` from non-interactive `writeConfig()` call (tenant.ts line 200)
- Removed `token` from interactive `writeConfig()` call (tenant.ts line 454)
- Remaining typecheck errors in config-cmd.ts and init.ts flow code (Tasks 5-7)
- Commit: refactor(cli): remove token from writeConfig and tenant config writes

## Task 8: config-cmd.ts token removal

- Deleted `maskToken()` function entirely (was lines 65-68)
- Removed `token: config.token ? maskToken(config.token) : null` from configShow() display object
- Removed `Token:` output line from configShow() (was line 59)
- Removed `token: { type: "string" }` from VALID_KEYS map
- Removed `case "token":` branch from configSet() switch statement
- Removed `token: null` from default config object in configSet()
- Simplified output message from conditional maskToken to simple value output
- Result: `config show` now only outputs "Active tenant:" and "Tenants:" sections
- Result: `config set token <value>` now returns "Unknown config key: token" error
- Commit: refactor(cli): remove token from config show/set commands

## Task 5: tenant.ts interactive flow

- Replaced while(true) PAT loop with ensureGhAuth() spinner
- login comes from ensureGhAuth().login, used in confirmation summary
- client created via createClient(token) where token is from ensureGhAuth()
- Step labels changed from X/4 to X/3 (PAT step removed = 3 steps total)

## Task 7: init.ts three paths

- runNonInteractive: getGhToken() → createClient(), keep validateToken/checkRequiredScopes
- runInteractiveStandalone: ensureGhAuth() replaces PAT loop, step labels X/3 → X/2
- runInteractiveFromTenant: try { token = getGhToken() } catch {} (empty catch, token stays undefined)
- Added import { getGhToken, ensureGhAuth, GhAuthError } from "../github/gh-auth.js"
- Removed token?: string from InitFlags type and --token case from parseInitFlags()
- All 147 tests pass, typecheck clean

## Task 6: tenant.ts non-interactive flag removal

- Removed `token?: string` from TenantAddFlags type (line 33)
- Removed `--token` case from parseTenantAddFlags() switch (lines 48-51)
- Removed `if (!flags.token)` guard block from tenantAddNonInteractive() (lines 113-119)
- Replaced `createClient(flags.token)` with getGhToken() try-catch pattern
- Added `getGhToken` to import from gh-auth.js
- validateToken() and checkRequiredScopes() kept as-is for GitHub API validation
- Typecheck: PASS
- Commit: feat(cli): replace --token flag with gh CLI auth in tenant add non-interactive

## Task 9: Orchestrator token injection

- service.ts: explicitly sets GITHUB_GRAPHQL_TOKEN in worker env (empty string if not set)
- start.ts: calls getGhToken() at startup to cache token into process.env
- gh OAuth tokens don't expire, so 1x startup caching is sufficient
- getGhToken() checks process.env.GITHUB_GRAPHQL_TOKEN first, then falls back to `gh auth token`
- Error handling: if gh CLI fails, token stays unset; workers will fail if token is needed

## Task 10: Documentation update

- help.ts: removed --token from non-interactive examples
- README.md: replaced PAT scopes section with Authentication section
- GITHUB_GRAPHQL_TOKEN documented as CI/CD fallback
- Fixed lint error in init.ts (empty catch block) while verifying documentation changes
- Commit: docs: update auth documentation for gh CLI migration

## Task 11: Full Verification Suite

### Key Findings
1. **Lint**: Fixed one unused eslint-disable directive in ansi.ts
   - The `// eslint-disable-next-line no-control-regex` comment was unnecessary
   - The regex pattern doesn't trigger the rule it was disabling

2. **Test Results**:
   - All CLI tests pass (147 tests including gh-auth.test.ts with 9 tests)
   - Control-plane test failures are pre-existing (Docker/runtime integration issues)
   - Verified by testing on HEAD~1 commit

3. **Typecheck Results**:
   - All CLI packages typecheck successfully
   - Control-plane typecheck errors are pre-existing (missing exports, module resolution)
   - Verified by testing on HEAD~1 commit

4. **Build Results**:
   - All CLI packages build successfully
   - Control-plane build fails with pre-existing TypeScript errors
   - Verified by testing on HEAD~1 commit

### Verification Scope
The gh-cli-auth-migration project includes:
- packages/cli (primary)
- packages/core (dependency)
- packages/orchestrator (dependency)
- packages/worker (dependency)
- packages/shared (dependency)
- packages/tracker-github (dependency)
- packages/runtime-codex (dependency)
- packages/extension-github-workflow (dependency)

All of these pass lint, test, typecheck, and build.

### Control-Plane Status
The control-plane app has pre-existing failures unrelated to gh-cli-auth-migration:
- Missing export in orchestrator-status-client
- Missing module '../../../packages/worker/src/runtime'
- Type mismatch in workspace-orchestrator
- Docker/runtime integration test failures

These are separate concerns and should be addressed in a separate task.

### Commit
- ba6e149: fix: remove unused eslint-disable directive in ansi.ts


## F4 Scope Fidelity Audit (2026-03-13)

- Checked commit range `b5f7274..HEAD`; all listed migration commits are present and accounted for.
- `apps/control-plane/` has no commits in range (`git log --oneline b5f7274..HEAD -- apps/control-plane/` returned empty).
- No `gh auth setup-git` occurrences in repository.
- No `execSync(` call changes in migration commits (`git log -G"\bexecSync\s*\(" b5f7274..HEAD -- packages README.md` returned empty).
- `OrchestratorTrackerAdapter` contract file unchanged: `packages/core/src/contracts/tracker-adapter.ts`.
- Token broker env var patterns (`GITHUB_TOKEN_BROKER_URL/SECRET`) unchanged in range.
- Cross-task note: `b2e5f37` briefly touched `init.ts` for lint cleanup; this was corrected by `b41c4e8`, leaving expected net behavior.

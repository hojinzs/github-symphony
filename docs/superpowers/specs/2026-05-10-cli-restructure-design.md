# CLI Restructure: Repo-Centric Cleanup

> **Date**: 2026-05-10
> **Status**: Draft (pending user approval)
> **Type**: BREAKING CHANGE
> **Scope**: `@gh-symphony/cli` (no orchestrator/core changes beyond removing legacy multi-project plumbing the CLI relied on)

## Background

The repo-centric refactor (issues #262, #263, #264, #265, #266) collapsed the orchestrator runtime to **1 repo : 1 orchestrator : 1 GitHub Project (resolved from `WORKFLOW.md`)**. Per-repo runtime now lives at `<repo>/.runtime/orchestrator/` and is initialized by `gh-symphony repo init`.

However, the CLI surface still exposes the pre-refactor multi-project model:

- Top-level `start` / `stop` / `status` / `run` / `recover` / `logs` resolve through the global `~/.gh-symphony/` and the legacy "active project" concept.
- `project add` / `list` / `remove` / `switch` / `start` / `stop` / `status` manipulate a global registry that is no longer used by the dispatch path.
- `repo add` / `remove` / `sync` mutate `repositories[]` (an array field that exists for legacy compat — `config.ts:131`), even though the orchestrator contract is `repository: RepositoryRef` (singular).
- Top-level `init` is a hidden alias of `workflow init`.

This produces three command paths to lifecycle verbs (top-level / `project` / `repo`) that look interchangeable but resolve from different config sources, and a `repositories[]` plumbing path that contradicts the single-repo contract.

## Goals

1. One canonical command per action — no aliases, no overlap.
2. CLI surface mirrors the actual runtime model: 1 repo = 1 orchestrator.
3. Help output is grouped by purpose with clear visual section breaks (matching the user-supplied screenshot).
4. Strip the legacy global multi-project plumbing the CLI exposes (`project` registry, `repositories[]` array, `repo add/remove/sync`).

## Non-goals

- No changes to `OrchestratorService`, core contracts, or runtime data layout (already correct).
- No changes to the worker, runtime adapters, or tracker adapter.
- No new commands. This is purely a removal + reorganization.
- No automated migration of existing global `~/.gh-symphony/` data — users running the new CLI must run `gh-symphony repo init` per repo. A clear error message points them to it.

## Final Command Structure

```
gh-symphony — AI Coding Agent Orchestrator

Setup:
  setup                Run the one-command first-run setup flow
  workflow init        Generate WORKFLOW.md and workflow support files
  workflow validate    Strictly validate WORKFLOW.md
  workflow preview     Render the worker prompt from a sample or live issue
  doctor               Run diagnostics and optional remediation
  config show          Show current configuration
  config set           Set a configuration value
  config edit          Open config in $EDITOR

Orchestration (current repository):
  repo init            Initialize gh-symphony for the current repository
  repo start           Start the orchestrator (foreground)
  repo start --daemon  Start the orchestrator in the background
  repo stop            Stop the background orchestrator
  repo status          Show orchestrator status
  repo run <issue>     Dispatch a single issue
  repo recover         Recover stalled runs
  repo logs            View orchestrator logs
  repo explain <issue> Explain why an issue is not dispatching

Maintenance:
  upgrade              Upgrade the CLI to the latest published version
  completion <shell>   Print shell completion (bash/zsh/fish)
  version              Show version
  help [command]       Show help for a command

Global Options:
  --config <dir>       Config directory override (advanced; default resolves
                       per-repo to <repo>/.runtime/orchestrator)
  --verbose, -v        Verbose output
  --json               JSON output
  --no-color           Disable color output
  --help, -h           Show help
  --version, -V        Show version
```

### What's removed (BREAKING)

| Removed | Replacement | Migration message |
|---|---|---|
| `gh-symphony init` | `gh-symphony workflow init` | "Use `gh-symphony workflow init`." |
| `gh-symphony start` | `gh-symphony repo start` | "Use `gh-symphony repo start` from the target repository." |
| `gh-symphony stop` | `gh-symphony repo stop` | "Use `gh-symphony repo stop`." |
| `gh-symphony status` | `gh-symphony repo status` | "Use `gh-symphony repo status`." |
| `gh-symphony run <issue>` | `gh-symphony repo run <issue>` | "Use `gh-symphony repo run <issue>`." |
| `gh-symphony recover` | `gh-symphony repo recover` | "Use `gh-symphony repo recover`." |
| `gh-symphony logs` | `gh-symphony repo logs` | "Use `gh-symphony repo logs`." |
| `gh-symphony project *` (entire namespace) | — | "The `project` command was removed. The orchestrator is now per-repository. Run `gh-symphony repo init` in the target repository." |
| `gh-symphony repo add <owner/name>` | — | "Removed. The orchestrator binds to the cwd repository via `repo init`." |
| `gh-symphony repo remove <owner/name>` | — | Same as above. |
| `gh-symphony repo sync` | — | "Removed. Single-repo model has no linked-repo set to sync." |
| `gh-symphony repo list` | — | The "list" was a list of `repositories[]` — that field is gone. Repository identity is shown by `repo status`. |
| `gh-symphony setup --project <id>` flag | (no replacement; `setup` becomes purely cwd-driven) | "Use `gh-symphony setup` from inside the target repository." |

Removed commands invoke a deprecation handler that prints the migration message to stderr and exits with code 2 (consistent with `rejectRemovedProjectId` precedent at `packages/cli/src/removed-project-id.ts`).

### What stays in `repo` and gains `explain`

`project explain <issue>` is moved to `repo explain <issue>` because it is now a per-repo diagnostic — it inspects `<repo>/.runtime/orchestrator/` data and the cwd `WORKFLOW.md`.

### Code paths to change

**Files deleted entirely**:

- `packages/cli/src/commands/init.ts` — the top-level alias for `workflow init` is removed; `workflow init` already has its own implementation under `commands/workflow.ts`.
- `packages/cli/src/commands/project.ts` — the `project` namespace is gone. Its `explain` subcommand is preserved by relocating the relevant code into `commands/repo.ts` (or a new `commands/repo-explain.ts`).

**Files retained as internal modules (no top-level Commander registration)**:

- `commands/start.ts`, `stop.ts`, `status.ts`, `run.ts`, `recover.ts`, `logs.ts` — these continue to host the lifecycle implementation. `repo.ts` already delegates to `startCommand` / `stopCommand` / `statusCommand` with `configDir` overridden via `repoOptions(...)`. The same pattern is extended to `run`, `recover`, `logs` (currently top-level only). Only the top-level `program.command("start"|...)` registrations in `index.ts` are removed.

**Files modified**:

- `packages/cli/src/index.ts` — drop top-level lifecycle command registrations, drop the `init` alias, drop the entire `project` group, drop `repo add/remove/sync/list` registrations. Add `repo run/recover/logs/explain`. Drop hidden `--project-id` / `--project` options from remaining `repo` subcommands.
- `packages/cli/src/commands/repo.ts` — remove `repoAdd`, `repoRemove`, `repoSync`, `repoList`, helpers (`buildSyncedRepositories`, multi-element `configuredRepositories`, `withConfiguredRepository`, `RepoSyncSummary`, etc.). Add `run`/`recover`/`logs`/`explain` subcommand handlers that delegate to existing modules with the repo-runtime `configDir`.
- `packages/cli/src/config.ts` — drop `repositories?: RepositoryRef[]` from `CliProjectConfig`, drop the legacy-compat block at line 131. Audit `loadGlobalConfig` and remove if no longer referenced after the `project` namespace deletion (the repo-runtime path uses `saveGlobalConfig` to write a single-entry `activeProject: "repository"` — keep the writer, examine the reader).
- `packages/cli/src/project-selection.ts` — audit; delete if it only fed the `project` namespace and the removed top-level lifecycle commands.
- `packages/cli/src/commands/doctor.ts` — line 687 (`projectConfig.projectConfig.repositories ?? []`) and similar reads of `repositories[]` are simplified to use the singular `repository` field.
- `packages/cli/src/commands/setup.ts` — drop the `--project <id>` flag handling and any `project add` invocation; setup becomes purely cwd-driven (`workflow init` + `repo init` orchestration).
- `packages/cli/src/commands/help.ts` — full rewrite (see "Help output rendering" below).
- `packages/cli/src/removed-project-id.ts` — kept until the last `--project-id` reference is gone, then deleted.

> Verification step during implementation: after the changes above, run `pnpm typecheck` and `pnpm lint` to surface any remaining reference to `loadGlobalConfig`, legacy `activeProject`, `repositories[]`, or `projectConfigPath`. Resolve case-by-case — most should be deletable.

### Help output rendering

`commands/help.ts` is rewritten to render the structure above using the existing `ansi.ts` helpers:

- Section labels (`Setup:`, `Orchestration (current repository):`, `Maintenance:`, `Global Options:`) — yellow bold.
- Command names — cyan.
- Descriptions — default color, aligned at column 22.
- Blank line between sections.

The output exactly matches the screenshot's grouping style and adds a fourth section (`Maintenance`) for housekeeping verbs.

The `--help` produced by Commander for the program root is replaced with a custom hook that delegates to `help.ts` so both `gh-symphony help` and `gh-symphony --help` render identically. Subcommand `--help` (e.g., `gh-symphony repo --help`) keeps Commander's default rendering, since per-group help is already adequate.

## Behavioral Changes

1. **`gh-symphony` (no args)** prints the new grouped help (current behavior already calls `program.outputHelp()` when no subcommand is invoked — it will pick up the new content automatically once the subtree is restructured).
2. **`gh-symphony repo` (no subcommand)** prints `repo`-group help (unchanged behavior, but the listed subcommands shrink).
3. **`gh-symphony` from a directory without `.runtime/orchestrator/`**: lifecycle commands (`repo start`, etc.) print a clear error pointing to `gh-symphony repo init` (this is already the case for `start.ts`'s "No repository is configured" path; the new message is sharpened).
4. **No `--project-id` / `--project` flags anywhere.** The existing `rejectRemovedProjectId` path is removed entirely once `project` namespace is gone, and Commander definitions drop the hidden `--project-id` / `--project` options on `repo *` subcommands.

## Migration / User-Facing Communication

A changeset entry is added with `major` bump:

```
@gh-symphony/cli: BREAKING — restructure CLI to repo-centric model

- Removed: top-level `start`, `stop`, `status`, `run`, `recover`, `logs`, `init`
- Removed: `project` namespace (add/list/remove/switch/start/stop/status/explain)
- Removed: `repo add`, `repo remove`, `repo sync`, `repo list`
- Added: `repo run`, `repo recover`, `repo logs`, `repo explain`
- The orchestrator now binds strictly to the cwd repository via `repo init`.
  Per-repo runtime: `<repo>/.runtime/orchestrator/`.
- Migrate by running `gh-symphony repo init` in each target repository.
```

`README.md` and `packages/cli/README.md` are updated to use the new commands throughout. Internal examples in error messages, doctor remediation hints, etc., are swept and updated.

## Testing Strategy

1. **Update existing tests** — `packages/cli/src/commands/lifecycle.test.ts`, `start.test.ts`, `status.test.ts`, `repo.test.ts`, `project.test.ts`, `init.test.ts` are pruned/rewritten to assert the new tree.
2. **New help-rendering test** — snapshot the `gh-symphony help` and `gh-symphony --help` output to lock the section grouping and ANSI-stripped layout.
3. **Deprecation-message test** — every removed command name (`init`, `start`, `stop`, `status`, `run`, `recover`, `logs`, `project`, `project add`, `repo add`, `repo remove`, `repo sync`, `repo list`) prints the documented migration message to stderr and exits with code 2.
4. **E2E** — the existing single-repo E2E flow (added under `test/266-single-repo-e2e`) should already pass as-is once it is updated to use `repo run` / `repo status` etc. Confirm during execution.
5. **Manual smoke** — in a real cloned repo: `repo init` → `repo status` → `repo run <issue>` → `repo logs` → `repo stop`. Verify per-repo runtime is the only path used.

## Implementation Order (preview)

This will be turned into a full plan by the writing-plans skill, but the rough order:

1. Rewrite `help.ts` with the new layout and grouped renderer.
2. Add a `removed-command.ts` helper (parallel to `removed-project-id.ts`) that prints the migration message and exits.
3. Wire `index.ts`: register `repo run`, `repo recover`, `repo logs`, `repo explain`. Replace `init`, `start`, `stop`, `status`, `run`, `recover`, `logs`, `project*`, `repo add/remove/sync/list` with the deprecation handler. Drop hidden `--project-id`/`--project` options from remaining subcommands.
4. In `repo.ts`: add the four new subcommand handlers (`run`/`recover`/`logs` delegate to the existing internal modules with `configDir = resolveRepoRuntimeRoot()`; `explain` is moved over from `project.ts`). Delete `init.ts` (the top-level alias) and `project.ts`. Trim `repo.ts` of `repoAdd`/`repoRemove`/`repoSync`/`repoList` and their helpers.
5. Remove `repositories[]` from `CliProjectConfig`, the legacy-compat block in `config.ts`, and any `repo add/remove/sync`-only helpers. Update `doctor.ts` to read the singular `repository` field. Simplify `setup.ts` to a cwd-only flow.
6. Update `packages/cli/README.md`, root `README.md`, doctor remediation strings, setup completion messages, and any in-code error hints.
7. Add changeset, run `pnpm lint && pnpm test && pnpm typecheck && pnpm build`, fix fallout.
8. Update or delete every test that referenced removed commands; add the help-snapshot and deprecation-message tests.

## Risks

- **Hidden coupling** — global config helpers (`loadGlobalConfig`, `projectConfigPath`) might still be referenced by something other than `project` / top-level lifecycle. The implementation must grep every removal and confirm. If a reference outside the deprecation surface remains, decide case-by-case (delete vs. keep).
- **E2E fixtures** — single-repo E2E (#266) uses these commands; needs updating in lockstep.
- **External docs/blog posts/scripts** — out of scope. Changeset note covers the announcement.

## Open questions resolved during brainstorming

- Should lifecycle live under `repo` or `project`? → **`repo`**, because the runtime is per-repo and `repo init` is the entry point. The `project` namespace was a vestige of the multi-project model and is removed entirely.
- Should `run`/`recover`/`logs` stay top-level for ergonomics? → **No.** Consistency under `repo` and elimination of any "act on the global active project" semantics outweighs the keystroke saving.
- Soft deprecation (warn but execute) vs. hard removal? → **Hard removal**, matching the precedent set by `rejectRemovedProjectId` (the team has already shipped breaking CLI changes with informative error messages and accepted the friction).

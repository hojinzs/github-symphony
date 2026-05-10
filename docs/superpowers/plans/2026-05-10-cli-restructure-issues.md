# CLI Restructure — Issue Breakdown Plan

> **Source spec:** `docs/superpowers/specs/2026-05-10-cli-restructure-design.md` (commit `4e5acfc`)
> **Repository:** `hojinzs/github-symphony`
> **Type:** BREAKING CHANGE (changeset will request a `major` bump on `@gh-symphony/cli`)

This plan splits the CLI restructure into **6 independently shippable GitHub issues**. Each issue body below is ready to paste into `gh issue create --body-file -`. The full design doc remains the single source of truth; each issue embeds the slice relevant to its scope.

## Dependency graph

```
        ┌─────────────────┐
        │ #A help refresh │   (independent — visual only, no behavior)
        └─────────────────┘

        ┌──────────────────────────────────┐
        │ #B deprecation handler infra     │   (foundational)
        └────────┬─────────────┬───────────┘
                 │             │             │
        ┌────────▼─────┐ ┌─────▼────────┐ ┌──▼──────────────────────┐
        │ #C top-level │ │ #D project   │ │ #E multi-repo plumbing  │
        │   removal    │ │   namespace  │ │   removal +             │
        │              │ │   removal +  │ │   repositories[] drop   │
        │              │ │   repo run/  │ │                         │
        │              │ │   recover/   │ │                         │
        │              │ │   logs/      │ │                         │
        │              │ │   explain    │ │                         │
        └────────┬─────┘ └──────┬───────┘ └────────────┬────────────┘
                 │              │                      │
                 └──────────────┴──────────────────────┘
                                │
                  ┌─────────────▼──────────────────┐
                  │ #F setup simplify + docs sweep │
                  │     + changeset + final QA     │
                  └────────────────────────────────┘
```

- **#A and #B** are independent and can start immediately, in either order.
- **#C, #D, #E** can run in parallel after #B lands. Each touches a disjoint surface, so merge conflicts are minimal.
- **#F** is the closer: it consumes the previous changes, sweeps docs, lands the changeset.

## Verification gates

Each issue's PR must pass:
```bash
pnpm lint && pnpm test && pnpm typecheck && pnpm build
```
The single-repo E2E in `test/266-single-repo-e2e` must continue to pass after #C–#F (any command-name updates to its fixtures land within the issue that renames them).

---

## Issue #A — Refresh `gh-symphony help` output (grouped layout)

**Title:** `feat(cli): refresh help output with grouped sections`
**Labels:** `cli`, `enhancement`
**Depends on:** none
**Estimated effort:** S

**Body (paste into GitHub):**

```markdown
## Summary
Rewrite `gh-symphony help` and `gh-symphony --help` output to use grouped sections with a clear visual hierarchy (yellow bold section headers, cyan command names, descriptions aligned at column 22, blank line between sections). The new layout matches the screenshot the maintainer provided and prepares the surface for the upcoming command tree changes (#B–#F).

This issue is **visual only** — no command behavior changes, no commands added or removed.

## Design slice (from `docs/superpowers/specs/2026-05-10-cli-restructure-design.md`)

Final command structure that the help text must render:

\`\`\`
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
\`\`\`

Rendering rules:
- Section labels — yellow bold via `ansi.ts` (`bold`, `yellow`).
- Command names — cyan via `ansi.ts` (`cyan`).
- Descriptions aligned at column 22 (left-padded).
- Blank line between sections.
- `--no-color` honored: when `setNoColor(true)` has run, no ANSI escapes are emitted.

## Files
- Modify: `packages/cli/src/commands/help.ts` — full rewrite of `HELP_TEXT` rendering.
- Modify: `packages/cli/src/index.ts` — register a `helpInformation` override (or a `program.configureHelp` hook) so `--help` uses the same renderer as `help`.

## Implementation outline
1. Replace the static `HELP_TEXT` template with a `renderHelp(options: { color: boolean }): string` function that builds sections programmatically.
2. Wire `program.configureHelp` (or `program.helpInformation = ...`) so `gh-symphony --help` calls the same renderer. Subgroup `--help` (e.g., `repo --help`) keeps Commander defaults.
3. Even though the new commands (`repo run/recover/logs/explain`) don't exist yet at this point, list them in the help output. They will exist before any user-facing release because #D lands ahead of any tag.

> **Note:** because this issue lists commands that do not yet exist (`repo run`, `repo recover`, `repo logs`, `repo explain`), it must merge before any release tag, but can merge in any order relative to #C–#E. Document this constraint in the PR description.

## Acceptance criteria
- [ ] `gh-symphony help` and `gh-symphony --help` produce byte-identical output.
- [ ] Sections render as: Setup, Orchestration (current repository), Maintenance, Global Options.
- [ ] `--no-color` strips all ANSI escapes from the output.
- [ ] Snapshot test added: `packages/cli/src/commands/help.test.ts` covers the colored and non-colored variants.
- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` pass.

## Reference
Full design: `docs/superpowers/specs/2026-05-10-cli-restructure-design.md`
```

---

## Issue #B — Deprecation handler infrastructure

**Title:** `feat(cli): add removed-command deprecation handler`
**Labels:** `cli`, `infrastructure`
**Depends on:** none
**Estimated effort:** S

**Body:**

```markdown
## Summary
Add a `removed-command.ts` helper that prints a migration message to stderr and exits with code 2. Modeled after the existing `removed-project-id.ts` pattern. This unblocks #C, #D, #E, which all replace removed commands with deprecation handlers.

## Design slice

> Removed commands invoke a deprecation handler that prints the migration message to stderr and exits with code 2 (consistent with `rejectRemovedProjectId` precedent at `packages/cli/src/removed-project-id.ts`).

The migration message table (full content lives in #C/#D/#E; this issue only ships the helper):

| Removed | Migration message |
|---|---|
| `init` | `Use 'gh-symphony workflow init'.` |
| `start` | `Use 'gh-symphony repo start' from the target repository.` |
| `stop` | `Use 'gh-symphony repo stop'.` |
| `status` | `Use 'gh-symphony repo status'.` |
| `run` (top-level) | `Use 'gh-symphony repo run <issue>'.` |
| `recover` (top-level) | `Use 'gh-symphony repo recover'.` |
| `logs` (top-level) | `Use 'gh-symphony repo logs'.` |
| `project *` | `The 'project' command was removed. The orchestrator is now per-repository. Run 'gh-symphony repo init' in the target repository.` |
| `repo add` | `Removed. The orchestrator binds to the cwd repository via 'repo init'.` |
| `repo remove` | (same) |
| `repo sync` | `Removed. Single-repo model has no linked-repo set to sync.` |
| `repo list` | `Removed. Repository identity is shown by 'repo status'.` |

## Files
- Create: `packages/cli/src/commands/removed-command.ts` — exports `createRemovedCommandHandler(message: string): CommandHandler`.
- Create: `packages/cli/src/commands/removed-command.test.ts` — verifies the handler writes the message to stderr and sets `process.exitCode = 2`.

## Implementation outline
\`\`\`ts
// packages/cli/src/commands/removed-command.ts
import type { CommandHandler } from "../index.js";

export function createRemovedCommandHandler(message: string): CommandHandler {
  return async () => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  };
}
\`\`\`

The helper does not consult global options (`--json` etc.) — removed commands always print plain text and exit 2.

## Acceptance criteria
- [ ] `createRemovedCommandHandler` returns a `CommandHandler` matching the existing signature in `packages/cli/src/index.ts`.
- [ ] Test confirms stderr output and exit code 2.
- [ ] No top-level commands are wired to it yet — that lands in #C, #D, #E.
- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` pass.

## Reference
Full design: `docs/superpowers/specs/2026-05-10-cli-restructure-design.md`
```

---

## Issue #C — Remove top-level lifecycle commands (`init`, `start`, `stop`, `status`, `run`, `recover`, `logs`)

**Title:** `feat(cli)!: remove top-level lifecycle commands (BREAKING)`
**Labels:** `cli`, `breaking-change`
**Depends on:** #B
**Estimated effort:** M

**Body:**

```markdown
## Summary
Remove the top-level Commander registrations for `init` (alias of `workflow init`), `start`, `stop`, `status`, `run <issue>`, `recover`, `logs`. Replace each with the deprecation handler from #B. The implementation modules (`commands/start.ts` etc.) are **kept** because `commands/repo.ts` already delegates to them — only the top-level registration in `index.ts` is removed. The `commands/init.ts` alias file is the only handler file deleted by this issue.

This is part 1 of 3 of the BREAKING CLI surface cleanup.

## Design slice

> Top-level `start` / `stop` / `status` / `run` / `recover` / `logs` resolve through the global `~/.gh-symphony/` and the legacy "active project" concept.
> Top-level `init` is a hidden alias of `workflow init`.

What's removed by this issue:

| Removed | Replacement | Migration message |
|---|---|---|
| `gh-symphony init` | `gh-symphony workflow init` | `Use 'gh-symphony workflow init'.` |
| `gh-symphony start` | `gh-symphony repo start` | `Use 'gh-symphony repo start' from the target repository.` |
| `gh-symphony stop` | `gh-symphony repo stop` | `Use 'gh-symphony repo stop'.` |
| `gh-symphony status` | `gh-symphony repo status` | `Use 'gh-symphony repo status'.` |
| `gh-symphony run <issue>` | `gh-symphony repo run <issue>` | `Use 'gh-symphony repo run <issue>'.` |
| `gh-symphony recover` | `gh-symphony repo recover` | `Use 'gh-symphony repo recover'.` |
| `gh-symphony logs` | `gh-symphony repo logs` | `Use 'gh-symphony repo logs'.` |

Files retained as internal modules: `commands/start.ts`, `stop.ts`, `status.ts`, `run.ts`, `recover.ts`, `logs.ts`. They will be invoked via `commands/repo.ts` in #D. Do NOT delete them in this issue.

## Files
- Modify: `packages/cli/src/index.ts` — remove `init` / `start` / `stop` / `status` / `run` / `recover` / `logs` Commander registrations. Wire each name to a `createRemovedCommandHandler(...)` registration so the user gets a clear message rather than Commander's default "unknown command" error.
- Delete: `packages/cli/src/commands/init.ts` (the top-level alias handler — its function existed only to forward to `workflow.ts`).
- Modify: `packages/cli/src/index.ts` — remove the `init` import from the `LoaderKey`/`COMMANDS` map.
- Modify: `packages/cli/src/commands/help.ts` — already updated in #A; verify it does not reference removed commands.
- Modify/Delete: `packages/cli/src/commands/init.test.ts` (and any sibling tests under `commands/*.test.ts`) — remove tests that assert top-level routing of removed commands; keep tests that cover `start.ts` / `stop.ts` / `status.ts` / `run.ts` / `recover.ts` / `logs.ts` as internal modules (they still execute via `repo`).
- Modify: `packages/cli/src/index.test.ts` — update top-level routing tests.

## Implementation outline
1. In `index.ts`, replace each `program.command("start").action(...)` block with a `program.command("start").action(createRemovedCommandHandler("Use 'gh-symphony repo start' from the target repository."))`.
2. Use `{ hidden: true, allowUnknownOption: true }` so the help output (#A) does not list these names — the user only sees them if they actually try to run them.
3. Remove the `init` entry from `COMMANDS` and delete `init.ts`.
4. Drop the hidden `--project-id` / `--project` options from any `repo` subcommand registrations that still carry them; users were already getting `rejectRemovedProjectId` errors, but the option declarations themselves can go now.
5. Run `pnpm typecheck` and resolve the inevitable cascade in tests.

## Acceptance criteria
- [ ] Running `gh-symphony start`, `gh-symphony stop`, `gh-symphony status`, `gh-symphony run owner/repo#1`, `gh-symphony recover`, `gh-symphony logs`, `gh-symphony init` each prints the documented migration message to stderr and exits with code 2.
- [ ] `gh-symphony --help` (rendered by #A) does not list any removed top-level command.
- [ ] `commands/start.ts`, `stop.ts`, `status.ts`, `run.ts`, `recover.ts`, `logs.ts` are still present (consumed by `repo.ts` in #D).
- [ ] `commands/init.ts` is deleted.
- [ ] All deprecation messages are covered by a regression test (one assertion per removed command name).
- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` pass.

## Reference
Full design: `docs/superpowers/specs/2026-05-10-cli-restructure-design.md`
```

---

## Issue #D — Migrate lifecycle into `repo`, remove `project` namespace

**Title:** `feat(cli)!: move run/recover/logs/explain under 'repo' and remove 'project' namespace (BREAKING)`
**Labels:** `cli`, `breaking-change`
**Depends on:** #B (and conflicts minimally with #C — see notes)
**Estimated effort:** M

**Body:**

```markdown
## Summary
Add `repo run <issue>`, `repo recover`, `repo logs`, `repo explain <issue>` to the `repo` subcommand group, delegating to the existing internal handlers (`commands/run.ts`, `commands/recover.ts`, `commands/logs.ts`) with `configDir` overridden to the per-repo runtime root. Move `project explain` logic into `repo explain`. Remove the entire `project` subcommand namespace (`add`, `list`, `remove`, `switch`, `start`, `stop`, `status`, `explain`) — replacing the top-level `project` command with a deprecation handler from #B.

This is part 2 of 3 of the BREAKING CLI surface cleanup.

## Design slice

> Should lifecycle live under `repo` or `project`? → `repo`, because the runtime is per-repo and `repo init` is the entry point. The `project` namespace was a vestige of the multi-project model and is removed entirely.
>
> `project explain <issue>` is moved to `repo explain <issue>` because it is now a per-repo diagnostic — it inspects `<repo>/.runtime/orchestrator/` data and the cwd `WORKFLOW.md`.

What's removed by this issue:

| Removed | Replacement | Migration message |
|---|---|---|
| `gh-symphony project *` (entire namespace) | `gh-symphony repo init` (for setup) / `repo explain` (for diagnostics) | `The 'project' command was removed. The orchestrator is now per-repository. Run 'gh-symphony repo init' in the target repository.` |

What's added:
- `gh-symphony repo run <issue>` — delegates to `commands/run.ts`
- `gh-symphony repo recover` — delegates to `commands/recover.ts`
- `gh-symphony repo logs` — delegates to `commands/logs.ts`
- `gh-symphony repo explain <issue>` — relocated from `commands/project.ts`

Each delegating call must override `configDir = resolveRepoRuntimeRoot()` (same pattern as the existing `repo start` → `startCommand` delegation in `commands/repo.ts:43-54`).

## Files
- Modify: `packages/cli/src/index.ts` — remove the entire `program.command("project")` block (and its subcommands `add`/`list`/`remove`/`switch`/`start`/`stop`/`status`/`explain`). Replace the top-level `project` command with a `createRemovedCommandHandler(...)`. Add new `repo run`, `repo recover`, `repo logs`, `repo explain` registrations under the existing `repo` group.
- Modify: `packages/cli/src/commands/repo.ts` — extend the `switch (subcommand)` block to handle `run`, `recover`, `logs`, `explain`. The first three delegate to the existing handlers via `repoOptions(options)`. `explain` is implemented inline (or in a new `commands/repo-explain.ts`) using the code currently in `project.ts`.
- Delete: `packages/cli/src/commands/project.ts`.
- Delete: `packages/cli/src/commands/project.test.ts` (rewrite the relevant `explain` cases under `repo.test.ts` or `repo-explain.test.ts`).
- Modify: `packages/cli/src/index.ts` — remove `project` from the `LoaderKey` union and the `COMMANDS` map.
- Modify: `packages/cli/src/commands/repo.ts` — remove the legacy `case "init"` (handled separately in `repo init`) only if the `init` registration in `index.ts` already covers it; keep the existing `repo init` flow intact.

## Implementation outline
1. Open `commands/project.ts`, copy the `explain` subcommand implementation (the `projectExplain` function and all of its helpers) into a new file `commands/repo-explain.ts`.
2. Replace any `loadGlobalConfig`/`activeProject` lookups in the copied code with `loadActiveProjectConfig(resolveRepoRuntimeRoot())`. The "active project" concept does not survive — the per-repo runtime always has the single `INTERNAL_PROJECT_ID = "repository"` config.
3. In `commands/repo.ts`, add `case "run" | "recover" | "logs" | "explain":` to the dispatcher. The first three call into the existing imported handlers with `repoOptions(options)`. `explain` calls into `repo-explain.ts`.
4. In `index.ts`, register `repo run <issue>`, `repo recover`, `repo logs`, `repo explain <issue>` in the existing `repo` group block. They follow the same `pushOption` plumbing the existing `repo start` registration uses.
5. Remove the `program.command("project")` block entirely. Add `program.command("project").action(createRemovedCommandHandler("The 'project' command was removed..."))` so the deprecation message shows up.
6. Delete `commands/project.ts` and `commands/project.test.ts`. Add `commands/repo-explain.test.ts` with the explain coverage.

## Conflict-management note
Touches `index.ts` in places that #C also touches. To minimize conflicts, land #C first; then this PR rebases. If they ship in parallel, expect merge conflicts in the program/registration block — straightforward to resolve.

## Acceptance criteria
- [ ] `gh-symphony repo run owner/repo#1` produces the same behavior as the old `gh-symphony run owner/repo#1` did, but reading from `<repo>/.runtime/orchestrator/`.
- [ ] `gh-symphony repo recover` and `gh-symphony repo logs` behave identically to their former top-level versions, against the per-repo runtime.
- [ ] `gh-symphony repo explain owner/repo#123` matches the former `gh-symphony project explain owner/repo#123` output.
- [ ] `gh-symphony project`, `gh-symphony project add`, `gh-symphony project list`, etc., each print the deprecation message and exit 2.
- [ ] `commands/project.ts` and `commands/project.test.ts` are deleted.
- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` pass.

## Reference
Full design: `docs/superpowers/specs/2026-05-10-cli-restructure-design.md`
```

---

## Issue #E — Remove multi-repo plumbing (`repo add/remove/sync/list`, `repositories[]`)

**Title:** `feat(cli)!: drop repo add/remove/sync/list and repositories[] field (BREAKING)`
**Labels:** `cli`, `breaking-change`
**Depends on:** #B
**Estimated effort:** M

**Body:**

```markdown
## Summary
Remove the `repo add`, `repo remove`, `repo sync`, `repo list` subcommands. Strip the `repositories?: RepositoryRef[]` field from `CliProjectConfig` and the legacy compatibility block in `config.ts` that tolerated the array. Update `doctor.ts` to read the singular `repository` field. The orchestrator contract has been single-repo (`OrchestratorProjectConfig.repository: RepositoryRef`) since the repo-centric refactor; this issue makes the CLI honest about that.

This is part 3 of 3 of the BREAKING CLI surface cleanup.

## Design slice

> `repo add` / `remove` / `sync` mutate `repositories[]` (an array field that exists for legacy compat — `config.ts:131`), even though the orchestrator contract is `repository: RepositoryRef` (singular).

What's removed by this issue:

| Removed | Migration message |
|---|---|
| `gh-symphony repo add <owner/name>` | `Removed. The orchestrator binds to the cwd repository via 'repo init'.` |
| `gh-symphony repo remove <owner/name>` | `Removed. The orchestrator binds to the cwd repository via 'repo init'.` |
| `gh-symphony repo sync` | `Removed. Single-repo model has no linked-repo set to sync.` |
| `gh-symphony repo list` | `Removed. Repository identity is shown by 'repo status'.` |
| `CliProjectConfig.repositories?: RepositoryRef[]` field | (deleted, no replacement — single `repository` field is the source of truth) |

## Files
- Modify: `packages/cli/src/index.ts` — remove the `repo.command("add"|"remove"|"sync"|"list")` registrations. Replace each with a `createRemovedCommandHandler(...)` so users running the old subcommand get a clear message.
- Modify: `packages/cli/src/commands/repo.ts` — delete the `case "add" | "remove" | "sync" | "list":` branches and the helpers `repoAdd`, `repoRemove`, `repoSync`, `repoList`, `buildSyncedRepositories`, `withConfiguredRepository`, `RepoSyncSummary`, `RepoSyncFlags`, `parseRepoSyncFlags`, `displayScopeError`, `writeRepoSummary`, `renderRepoGroup`, `sortRepos`, and the multi-element `configuredRepositories` helper. Trim imports (`getProjectDetail`, `LinkedRepository`, etc.) accordingly.
- Modify: `packages/cli/src/config.ts` — drop the `repositories?: RepositoryRef[]` property from `CliProjectConfig`. Drop the legacy compat block at line ~131 ("P1 compat: tolerate legacy `repositories[]`"). Confirm `loadActiveProjectConfig` still returns a valid singular `repository`.
- Modify: `packages/cli/src/commands/doctor.ts:687` — replace `[..., ...(projectConfig.projectConfig.repositories ?? [])]` with the singular `[projectConfig.projectConfig.repository]` (filter out null/undefined as needed).
- Modify: `packages/cli/src/commands/init.ts` (workflow init flow, NOT the top-level alias which #C deletes) — line 1299 writes `repositories: input.repos.map(...)`. If this code path is still needed, switch it to write a singular `repository`. Audit other callers of the array.
- Modify: `packages/cli/src/repo-runtime.ts:175` — `repositories: [repository]` is no longer needed; just write `repository` (already there). Remove the redundant array write.
- Modify: `packages/cli/src/commands/repo.test.ts` — delete tests for removed subcommands; keep tests for `repo init` / `start` / `stop` / `status` (and the new ones from #D).
- Modify: `packages/cli/src/commands/doctor.test.ts` — update fixtures to use singular `repository`.
- Modify: `packages/cli/src/commands/init.test.ts` (workflow init tests) — update fixture writes if needed.

## Implementation outline
1. Audit grep: `grep -rn "repositories" packages/cli/src --include="*.ts"`. Every reference must either be deleted or migrated to the singular field.
2. Update `CliProjectConfig` first; `pnpm typecheck` will surface every consumer.
3. Walk consumers in this order: `repo-runtime.ts`, `commands/init.ts`, `commands/repo.ts`, `commands/doctor.ts`, `commands/setup.ts`, `commands/project.ts` (already deleted by #D — skip if so), tests.
4. After typecheck is green, exercise the user flows manually: `repo init` → `repo status` → `doctor` from a fresh repo. None should reference `repositories`.

## Acceptance criteria
- [ ] `gh-symphony repo add owner/name`, `gh-symphony repo remove owner/name`, `gh-symphony repo sync`, `gh-symphony repo list` each print the documented deprecation message and exit 2.
- [ ] `grep -rn "repositories" packages/cli/src --include="*.ts"` returns no remaining occurrences (other than legitimate string literals like error messages or test fixtures that intentionally exercise the deprecation message).
- [ ] `CliProjectConfig` no longer contains `repositories?: RepositoryRef[]`.
- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` pass.
- [ ] Manual smoke: `repo init` in a fresh repo, then `repo status` shows the bound repo correctly, and `doctor` does not error on the missing array.

## Reference
Full design: `docs/superpowers/specs/2026-05-10-cli-restructure-design.md`
```

---

## Issue #F — Setup simplification, docs sweep, changeset, final QA

**Title:** `chore(cli)!: simplify setup, sweep docs, add changeset for v1 surface`
**Labels:** `cli`, `breaking-change`, `documentation`
**Depends on:** #C, #D, #E
**Estimated effort:** M

**Body:**

```markdown
## Summary
Final closer for the CLI restructure. Drop the `--project <id>` flag from `gh-symphony setup` (setup becomes purely cwd-driven: `workflow init` + `repo init`). Sweep `README.md`, `packages/cli/README.md`, doctor remediation strings, setup completion messages, and any other in-code reference to removed commands. Add a major-bump changeset describing the breaking changes.

## Design slice

> `setup --project <id>` flag — (no replacement; `setup` becomes purely cwd-driven). Migration message: "Use `gh-symphony setup` from inside the target repository."
>
> `README.md` and `packages/cli/README.md` are updated to use the new commands throughout. Internal examples in error messages, doctor remediation hints, etc., are swept and updated.
>
> A changeset entry is added with `major` bump:
>
> \`\`\`
> @gh-symphony/cli: BREAKING — restructure CLI to repo-centric model
>
> - Removed: top-level `start`, `stop`, `status`, `run`, `recover`, `logs`, `init`
> - Removed: `project` namespace (add/list/remove/switch/start/stop/status/explain)
> - Removed: `repo add`, `repo remove`, `repo sync`, `repo list`
> - Added: `repo run`, `repo recover`, `repo logs`, `repo explain`
> - The orchestrator now binds strictly to the cwd repository via `repo init`.
>   Per-repo runtime: `<repo>/.runtime/orchestrator/`.
> - Migrate by running `gh-symphony repo init` in each target repository.
> \`\`\`

## Files
- Modify: `packages/cli/src/commands/setup.ts` — drop `--project <id>`, `--workspace-dir`, and any `project add` invocation. Setup orchestrates `workflow init` + `repo init` against the cwd.
- Modify: `packages/cli/src/index.ts` — remove the `--project` and `--workspace-dir` options from the `setup` Commander registration.
- Modify: `packages/cli/src/commands/setup.test.ts` — update fixtures.
- Modify: `packages/cli/src/commands/doctor.ts` — line 606 ("Run 'gh-symphony init' in this repository...") and line 626 ("re-run 'gh-symphony init'...") update to `gh-symphony workflow init` (or `gh-symphony repo init`, whichever is correct for the failure mode). Walk every other `'gh-symphony <removed-command>'` string.
- Modify: `packages/cli/src/commands/start.ts:849` — daemon log line says `Stop with: gh-symphony repo stop`; verify this is still accurate after #D (it should be).
- Modify: `packages/cli/src/commands/project.ts:128` — already deleted by #D, verify no stragglers.
- Modify: `README.md` (root) — replace every `gh-symphony start`, `gh-symphony status`, `gh-symphony stop`, `gh-symphony run`, `gh-symphony logs`, `gh-symphony recover`, `gh-symphony init`, `gh-symphony project ...`, `gh-symphony repo add/remove/sync/list ...` with the new equivalents. Several lines listed in the design doc audit.
- Modify: `packages/cli/README.md` — same sweep.
- Modify: `docs/CONTROL_PLANE.md:278` — references `gh-symphony start` and `gh-symphony project start`; update.
- Modify: `docs/2026-05-04_single-repo-orchestrator-feasibility.md:25` — references `gh-symphony start`; update or annotate as historical.
- Modify: ADR / `.sisyphus/plans/*.md` — these are historical artifacts; leave them as-is unless the new commands fundamentally invalidate the documents (a pre-PR judgment).
- Create: `.changeset/cli-repo-centric-major.md` — major-bump changeset using the body above.

## Implementation outline
1. Walk every match from `grep -rn "gh-symphony \(start\|stop\|status\|run\|recover\|logs\|init\|project\|repo add\|repo remove\|repo sync\|repo list\)" --include="*.md" --include="*.ts"` and update or annotate.
2. Add the changeset.
3. Run the single-repo E2E (`test/266-single-repo-e2e`) end-to-end against the new command names — update fixtures inside this issue if any test still says `gh-symphony start` or similar.
4. Final `pnpm lint && pnpm test && pnpm typecheck && pnpm build`.
5. Manual smoke in a real repo: clone → `repo init` → `repo status` → `repo run owner/repo#N` → `repo logs` → `repo stop`. Confirm no friction.

## Acceptance criteria
- [ ] `gh-symphony setup` works without any flags from the cwd of a cloned repo.
- [ ] `gh-symphony setup --project <id>` either prints a deprecation message or fails Commander parsing (decide during implementation; either is acceptable as long as the user sees a clear error).
- [ ] No references to removed commands remain in `README.md`, `packages/cli/README.md`, doctor strings, or setup completion messages.
- [ ] Changeset committed under `.changeset/` with `@gh-symphony/cli: major`.
- [ ] Single-repo E2E passes against the new command tree.
- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` pass.

## Reference
Full design: `docs/superpowers/specs/2026-05-10-cli-restructure-design.md`
```

---

## Issue creation commands

When ready, create the six issues with:

```bash
# Run from repo root. The bodies above can be copied into each `--body-file` input.
# Use --label flags only if the labels exist in the repo; otherwise drop them.

gh issue create --title "feat(cli): refresh help output with grouped sections" --body-file <(...)        # #A
gh issue create --title "feat(cli): add removed-command deprecation handler" --body-file <(...)         # #B
gh issue create --title "feat(cli)!: remove top-level lifecycle commands (BREAKING)" --body-file <(...) # #C
gh issue create --title "feat(cli)!: move run/recover/logs/explain under 'repo' and remove 'project' namespace (BREAKING)" --body-file <(...)  # #D
gh issue create --title "feat(cli)!: drop repo add/remove/sync/list and repositories[] field (BREAKING)" --body-file <(...)  # #E
gh issue create --title "chore(cli)!: simplify setup, sweep docs, add changeset for v1 surface" --body-file <(...)  # #F
```

After creation, link follow-up issues by editing each body to include `Depends on: #<N>` lines, or use the GitHub Projects "blocking" relationship.

## Self-review against the spec

Spec coverage check (every spec section must map to at least one issue):

| Spec section | Issue(s) |
|---|---|
| Goals | #A (3), #B/#C/#D/#E (1, 2, 4), #F (4) |
| Non-goals | All issues respect — no orchestrator/core changes |
| Final Command Structure | #A renders it, #C/#D/#E remove the deprecated entries |
| What's removed table | #C (rows 1–7), #D (row 8 + project namespace), #E (rows 9–12), #F (row 13: setup --project) |
| Code paths to change | #C (init.ts delete, top-level reg removal), #D (project.ts delete, repo.ts add), #E (repo.ts trim, config.ts, doctor.ts, repo-runtime.ts, init.ts), #F (setup.ts, README sweep) |
| Help output rendering | #A |
| Behavioral Changes (1) | #A |
| Behavioral Changes (2) | #D, #E |
| Behavioral Changes (3) | #F (sharpened error messages in setup/doctor) |
| Behavioral Changes (4) | #C, #D, #E (drop hidden --project-id options) |
| Migration / changeset | #F |
| Testing Strategy (1) | #C, #D, #E (each ships its test updates) |
| Testing Strategy (2) | #A (snapshot test) |
| Testing Strategy (3) | #B (handler test) + each removal issue (per-command assertions) |
| Testing Strategy (4) | #F (E2E sweep) |
| Testing Strategy (5) | #F (manual smoke) |
| Risks (hidden coupling) | #E (audit step) |
| Risks (E2E fixtures) | #F |
| Risks (external docs) | #F changeset note |
| Open questions | All resolved in the spec; nothing to re-litigate |

No gaps. No unresolved placeholders. Type/method consistency: `createRemovedCommandHandler` (#B) is referenced consistently in #C/#D/#E. `repoOptions(options)` and `resolveRepoRuntimeRoot()` are used consistently for delegation. `INTERNAL_PROJECT_ID = "repository"` is honored throughout (no per-issue redefinition).

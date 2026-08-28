# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitHub Symphony — a multi-tenant AI coding agent orchestration platform built on the Symphony specification (`docs/symphony-spec.md`, read-only). The repository is a pnpm monorepo (pnpm 9+, Node.js 24+) with strict TypeScript.

## Common Commands

```bash
pnpm install              # Install dependencies
pnpm build                # Build all packages (pnpm -r build)
pnpm lint                 # ESLint across all packages
pnpm test                 # Vitest across all packages
pnpm typecheck            # TypeScript strict check (sequential)
pnpm format               # Prettier check
pnpm format:write         # Prettier auto-fix

# Single package
pnpm --filter @gh-symphony/core test
pnpm --filter @gh-symphony/orchestrator build

# Single test file
npx vitest run packages/core/src/workflow/workflow-loader.test.ts

```

Before shipping: `pnpm lint && pnpm test && pnpm typecheck && pnpm build`

**After completing work, always write test cases and run the tests to verify.** Integration behavior that unit tests cannot cover is verified with black-box tests in the Docker E2E environment. See [AGENT_TEST.md](AGENT_TEST.md) for the concrete procedure.

## Architecture

### Six Symphony Layers

All work must be classified against these layers (per `AGENTS.md`):

1. **Policy** — `WORKFLOW.md` prompt and team rules (repo-defined, per-repository)
2. **Configuration** — Workflow config parsing and validation
3. **Coordination** — Orchestrator polling, dispatch, leases, retries, recovery
4. **Execution** — Worker filesystem lifecycle, agent subprocess
5. **Integration** — GitHub tracker adapter (tracker-specific code stays here)
6. **Observability** — Structured events and status snapshots

### Package Dependency Graph

```
cli (published entrypoint; bundles the rest via devDependencies)
orchestrator ──→ core, runtime-claude, runtime-codex, tracker-file, tracker-github, tracker-linear
worker ────────→ core, extension-github-workflow, runtime-claude, runtime-codex, tool-github-graphql, tracker-github
control-plane ─→ core, dashboard
runtime-{claude,codex} ─→ core, tool-github-graphql, tool-linear-graphql
tracker-{github,linear,file} ─→ core (+tool-github-graphql for github)
extension-github-workflow, dashboard, tool-github-graphql ─→ core
```

The full component-to-package map, sliced by Symphony layer, lives in [docs/architecture.md](docs/architecture.md) — keep it updated when moving code across packages or layers.

### Key Packages

- **`packages/core`** — Domain types, contracts (`OrchestratorStateStore`, `OrchestratorTrackerAdapter`), workflow loading/config, lifecycle (`WorkflowExecutionPhase`: planning → human-review → implementation → awaiting-merge → completed), MCP config composition, observability snapshots. No external dependencies.
- **`packages/cli`** — `gh-symphony` published entrypoint: `setup`, `doctor`, `workflow`, `config`, `repo` (init/start/stop/status/run/logs/recover/explain), and `project` (standalone project list/start/status/stop, addressed by folder).
- **`packages/orchestrator`** — `OrchestratorService` dispatch loop, filesystem-backed state store (`OrchestratorFsStore`), shared bare clone cache + worktree populate, layered skill injection, leases/retries/recovery.
- **`packages/worker`** — Runs a single issue; drives a runtime adapter; manages approval workflow and hooks. The CLI start command hosts `/api/v1/state` through the control plane.
- **`packages/runtime-codex` / `packages/runtime-claude`** — Agent runtime adapters (Codex app-server protocol; Claude print mode).
- **`packages/tracker-github` / `-linear` / `-file`** — Tracker adapters implementing `OrchestratorTrackerAdapter` (file is E2E-only).
- **`packages/control-plane` / `packages/dashboard`** — Operator HTTP API (bearer-authenticated, default `:4680`) and browser dashboard.
- **`packages/tool-github-graphql` / `-linear-graphql`** — Runtime-neutral GraphQL MCP tools.
- **`packages/extension-github-workflow`** — GitHub-specific planning/approval/PR-reporting extensions.

### Key Contracts (in core)

- `OrchestratorTrackerAdapter` — listIssues, buildWorkerEnvironment, reviveIssue
- `OrchestratorStateStore` — loadWorkspaceConfigs, saveRun, appendRunEvent, leases
- `WorkflowLifecycleConfig` — maps tracker state strings to execution phases

### Runtime State

Filesystem state lives under `.runtime/orchestrator/`:

- `workspaces/<id>/config.json` — workspace metadata
- `workspaces/<id>/leases.json` — issue-phase leases
- `runs/<run-id>/run.json` — run snapshots
- `runs/<run-id>/events.ndjson` — structured events

## Releases

The single publish unit is `@gh-symphony/cli`. Behavior-changing PRs must add a changeset (`.changeset/*.md`, package `"@gh-symphony/cli"`); the changeset-release bot PR publishes to npm on merge. Docs-only changes need no changeset.

## Code Conventions

- **TypeScript strict mode** — do not weaken compiler settings
- **Prettier**: double quotes, semicolons, trailing commas (es5)
- **ESLint**: flat config, unused vars prefixed with `_`
- **Tests**: `*.test.ts` files, Vitest, node environment
- **Build output**: `dist/` for libraries
- **Workspace protocol**: `workspace:*` version specifiers between packages

## Spec Discipline

- `docs/symphony-spec.md` is the upstream spec — never modify it
- Divergences from the spec must be explicit and documented in change artifacts
- GitHub-specific semantics are extensions layered on top of Symphony core
- Keep tracker-specific behavior out of core layers
- Keep workflow-policy behavior separate from orchestration-core behavior

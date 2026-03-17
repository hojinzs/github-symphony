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

**작업 완료 후 반드시 TC를 작성하고 테스트를 실행하여 검증해야 한다.** 단위 테스트로 충분하지 않은 통합 동작은 Docker E2E 환경에서 블랙박스 테스트로 검증한다. 구체적인 방법은 [AGENT_TEST.md](AGENT_TEST.md) 참조.

## Architecture

### Six Symphony Layers

All work must be classified against these layers (per `AGENT.md`):

1. **Policy** — `WORKFLOW.md` prompt and team rules (repo-defined, per-repository)
2. **Configuration** — Workflow config parsing and validation
3. **Coordination** — Orchestrator polling, dispatch, leases, retries, recovery
4. **Execution** — Worker filesystem lifecycle, agent subprocess
5. **Integration** — GitHub tracker adapter (tracker-specific code stays here)
6. **Observability** — Structured events and status snapshots

### Package Dependency Graph

```
orchestrator ──→ core, tracker-github
worker ──────→ core, runtime-codex, tracker-github, extension-github-workflow
runtime-codex ─→ core
tracker-github ─→ core
extension-github-workflow ─→ core
```

### Key Packages

- **`packages/core`** — Domain types, contracts (`OrchestratorStateStore`, `OrchestratorTrackerAdapter`), workflow lifecycle (`WorkflowExecutionPhase`: planning → human-review → implementation → awaiting-merge → completed), orchestration records, observability snapshots. No external dependencies.
- **`packages/orchestrator`** — CLI entrypoint, `OrchestratorService` dispatch loop, filesystem-backed state store (`OrchestratorFsStore`), status HTTP server (default `:4680`). Commands: `run`, `run-once`, `dispatch`, `run-issue`, `recover`, `status`.
- **`packages/worker`** — Runs a single issue; serves `/api/v1/state`; integrates with Codex runtime; manages approval workflow and after-create hooks.
- **`packages/runtime-codex`** — Codex AI runtime integration (launcher, session, git-credential-helper, github-graphql tool).
- **`packages/tracker-github`** — `GitHubTrackerAdapter` implementing `OrchestratorTrackerAdapter` contract.

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

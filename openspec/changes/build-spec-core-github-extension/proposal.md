## Why

The current repository captures parts of the Symphony model, but it still treats GitHub Project workflows, runtime behavior, and human approval semantics as product-specific core behavior instead of extensions on top of the Symphony specification. This makes it hard to claim SPEC-level conformance, to reason about tracker-agnostic orchestration behavior, and to evolve GitHub-specific workflow logic without further coupling core orchestration code to one integration profile.

## What Changes

- Re-align the core orchestrator, worker runtime, workflow contract, and workspace lifecycle with the Symphony specification as the primary product contract.
- Recompose the package layout around a Symphony-first architecture with `packages/core`, `packages/runtime-codex`, `packages/tracker-github`, `packages/extension-github-workflow`, and a thinner service/composition layer.
- Introduce a spec-conformant `WORKFLOW.md` contract based on YAML front matter plus prompt body, including reloadable runtime settings and repository-owned workflow policy.
- Define persistent per-issue workspace behavior, hook lifecycle, retry/continuation semantics, reconciliation, and status surfaces according to the core Symphony execution model.
- Re-scope GitHub Project and GitHub Issue support as a first-party tracker extension layered on top of the core tracker contract instead of as the implicit default runtime model.
- Re-scope planning, approval, implementation, and merge completion behavior as workflow and human-in-the-loop extensions that build on core Symphony execution instead of redefining it.

## Capabilities

### New Capabilities
- `symphony-core-conformance`: Defines the tracker-agnostic Symphony core contract for workflow loading, dispatch, workspace lifecycle, runtime execution, reconciliation, retry, and observability.

### Modified Capabilities
- `cli-orchestrator-service`: Tighten the CLI orchestrator contract so it behaves as the authoritative SPEC-conformant coordinator rather than a GitHub-shaped dispatcher.
- `issue-driven-agent-execution`: Update issue execution requirements to use the Symphony prompt/render/session model and keep tracker mutation at the runtime extension boundary.
- `isolated-symphony-runtime`: Update runtime requirements to cover spec-conformant app-server session management, persistent issue workspaces, hook execution, and state reporting.
- `github-project-tracker-adapter`: Reframe GitHub Project and GitHub Issue behavior as an optional tracker extension on top of the core tracker contract.
- `approval-gated-agent-workflow`: Reframe planning, human review, implementation, and merge completion as workflow and human-in-the-loop extensions on top of the Symphony core.

## Impact

- Affected code: `packages/shared`, `packages/orchestrator`, `packages/worker`, new `packages/core`, new `packages/runtime-codex`, new `packages/tracker-github`, new `packages/extension-github-workflow`, a thinner service/composition layer, `apps/control-plane`, runtime artifact generation, and OpenSpec capability definitions.
- Affected contracts: `WORKFLOW.md` format, workspace layout, run lifecycle, status APIs, and tracker adapter boundaries.
- Affected integrations: GitHub Project polling, GitHub issue/PR mutation tooling, approval workflow semantics, and control-plane orchestration visibility.
- Dependencies and risks: Requires architectural refactoring across core orchestration and runtime packages, compatibility planning for existing GitHub-first workspace setup, and migration of current generated workflow artifacts to the new contract.

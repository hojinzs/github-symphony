## 1. Core workflow contract

- [x] 1.0 Recompose the package layout around `packages/core`, `packages/runtime-codex`, `packages/tracker-github`, `packages/extension-github-workflow`, and a thin service/composition layer.
- [x] 1.0.1 Create `packages/core` with spec-shaped internal modules for domain, workflow, orchestration, workspace, contracts, and observability.
- [x] 1.0.2 Create `packages/runtime-codex`, `packages/tracker-github`, and `packages/extension-github-workflow` with package-level README or entrypoint contracts that explain their boundaries.
- [x] 1.1 Replace the custom section-based `WORKFLOW.md` parser with a YAML front matter + prompt body loader and typed config layer, keeping only a temporary compatibility fallback for legacy sectioned workflow files.
- [x] 1.2 Add workflow validation, environment indirection, and last-known-good reload behavior for invalid updates.
- [x] 1.3 Add workflow file watch/reload plumbing so future poll, retry, hook, and runtime-launch decisions use the latest valid config while running sessions keep their launch-time workflow snapshot.
- [x] 1.4 Move Symphony domain types, workflow/config, orchestration state, workspace lifecycle, and status/log contracts out of `packages/shared` and `packages/orchestrator` into `packages/core`.
- [x] 1.5 Reduce `packages/shared` to a temporary compatibility shim or remove it entirely once imports point at the new packages.

## 2. Persistent issue workspace lifecycle

- [x] 2.1 Refactor workspace ownership from run-scoped clone directories to persistent per-issue workspace directories derived from canonical issue subject identity rather than GitHub Project placement.
- [x] 2.2 Implement the full hook lifecycle for `after_create`, `before_run`, `after_run`, and `before_remove` with timeout handling and operator-visible failures, including `cleanup_blocked` behavior when `before_remove` fails.
- [x] 2.3 Update startup cleanup and active reconciliation so terminal issues trigger issue-workspace cleanup without deleting orchestration records.

## 3. Spec-conformant orchestrator and runtime

- [x] 3.1 Refactor the orchestrator to use spec-level continuation, exponential retry backoff, recovery retry handling, and issue eligibility reconciliation.
- [x] 3.2 Implement prompt rendering with normalized `issue` and `attempt` variables and pass the rendered prompt into the worker session lifecycle.
- [x] 3.3 Split the current worker/runtime logic into `packages/runtime-codex` and upgrade it from a simple launcher to a Symphony session client that starts app-server threads and turns, tracks session state, and reports a stable minimal machine-readable runtime snapshot.
- [x] 3.4 Align status surfaces and structured logging with the spec-level runtime snapshot contract, including active sessions, retry queue state, retry kind, and aggregate runtime signals.
- [x] 3.5 Move filesystem-backed orchestrator persistence behind a core `state-store` contract and keep the filesystem implementation in the thin service/composition layer.

## 4. GitHub tracker extension boundary

- [x] 4.1 Split GitHub integration into `packages/tracker-github` and `packages/extension-github-workflow`, then refactor GitHub Project polling and issue normalization so the orchestrator consumes them only through the core tracker adapter contract.
- [x] 4.2 Keep GitHub mutation behavior behind the `github_graphql` runtime-tool extension and remove any remaining backend assumptions that normal tracker mutation is core orchestrator behavior.
- [x] 4.3 Rework GitHub-specific configuration and validation so GitHub remains a first-party extension without shaping the core workflow/runtime contract, including project field/option validation, placement integrity checks, and manual issue-transfer rebind handling.
- [x] 4.4 Move planning comments, pull request reporting, and handoff verification logic out of the current worker package and into `packages/extension-github-workflow`.

## 5. Workflow and human-in-the-loop extensions

- [x] 5.1 Rework planning, approval, implementation, and merge-completion logic so it is driven by workflow-defined states and extension helpers rather than hard-coded core semantics.
- [x] 5.2 Ensure implementation runs resume in the existing issue workspace while still starting a new execution session after human approval.
- [x] 5.3 Document and enforce the operator intervention points for approval, suppression, retry, handoff repair, cleanup retry/force remove, and issue-closure-driven completion.

## 6. Control plane compatibility and migration

- [x] 6.1 Replace the current thick orchestrator package boundary with a thin service/composition layer that wires `packages/core`, `packages/runtime-codex`, `packages/tracker-github`, and `packages/extension-github-workflow`.
- [x] 6.2 Update control-plane provisioning so repository `WORKFLOW.md` remains the canonical workflow contract and generated artifacts are reduced to compatibility or bootstrap helpers only.
- [x] 6.3 Update workspace/runtime metadata models and APIs to reference issue-scoped workspaces and spec-level status surfaces.
- [x] 6.4 Add a compatibility path or migration strategy for existing GitHub-first workspaces during the transition, including eventual removal of the legacy workflow compatibility fallback.
- [x] 6.5 Keep the existing status server and CLI entrypoints working during migration by redirecting them to the new service/composition layer before removing old package-level wiring.

## 7. Verification

- [x] 7.1 Add core conformance tests for workflow parsing, reload, workspace lifecycle, reconciliation, retry, and runtime session behavior.
- [x] 7.2 Update GitHub extension tests to verify the new adapter boundary and runtime-tool mutation flow.
- [ ] 7.3 Run the project verification suite and confirm the new change is ready for implementation without regressing current GitHub-focused behavior.

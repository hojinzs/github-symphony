## 1. Core workflow contract

- [ ] 1.1 Replace the custom section-based `WORKFLOW.md` parser with a YAML front matter + prompt body loader and typed config layer.
- [ ] 1.2 Add workflow validation, environment indirection, and last-known-good reload behavior for invalid updates.
- [ ] 1.3 Add workflow file watch/reload plumbing so future poll, retry, hook, and runtime-launch decisions use the latest valid config.

## 2. Persistent issue workspace lifecycle

- [ ] 2.1 Refactor workspace ownership from run-scoped clone directories to persistent per-issue workspace directories derived from sanitized issue identifiers.
- [ ] 2.2 Implement the full hook lifecycle for `after_create`, `before_run`, `after_run`, and `before_remove` with timeout handling and operator-visible failures.
- [ ] 2.3 Update startup cleanup and active reconciliation so terminal issues trigger issue-workspace cleanup without deleting orchestration records.

## 3. Spec-conformant orchestrator and runtime

- [ ] 3.1 Refactor the orchestrator to use spec-level continuation, exponential retry backoff, stall handling, and issue eligibility reconciliation.
- [ ] 3.2 Implement prompt rendering with normalized `issue` and `attempt` variables and pass the rendered prompt into the worker session lifecycle.
- [ ] 3.3 Upgrade the worker from a simple launcher to a Symphony session client that starts app-server threads and turns, tracks session state, and reports machine-readable runtime status.
- [ ] 3.4 Align status surfaces and structured logging with the spec-level runtime snapshot contract, including active sessions, retry queue state, and aggregate runtime signals.

## 4. GitHub tracker extension boundary

- [ ] 4.1 Refactor GitHub Project polling and issue normalization so the orchestrator consumes them only through the core tracker adapter contract.
- [ ] 4.2 Keep GitHub mutation behavior behind the `github_graphql` runtime-tool extension and remove any remaining backend assumptions that normal tracker mutation is core orchestrator behavior.
- [ ] 4.3 Rework GitHub-specific configuration and validation so GitHub remains a first-party extension without shaping the core workflow/runtime contract.

## 5. Workflow and human-in-the-loop extensions

- [ ] 5.1 Rework planning, approval, implementation, and merge-completion logic so it is driven by workflow-defined states and extension helpers rather than hard-coded core semantics.
- [ ] 5.2 Ensure implementation runs resume in the existing issue workspace while still starting a new execution session after human approval.
- [ ] 5.3 Document and enforce the operator intervention points for approval, suppression, retry, and merge-driven completion.

## 6. Control plane compatibility and migration

- [ ] 6.1 Update control-plane provisioning so repository `WORKFLOW.md` remains the canonical workflow contract and generated artifacts are reduced to compatibility or bootstrap helpers only.
- [ ] 6.2 Update workspace/runtime metadata models and APIs to reference issue-scoped workspaces and spec-level status surfaces.
- [ ] 6.3 Add a compatibility path or migration strategy for existing GitHub-first workspaces during the transition.

## 7. Verification

- [ ] 7.1 Add core conformance tests for workflow parsing, reload, workspace lifecycle, reconciliation, retry, and runtime session behavior.
- [ ] 7.2 Update GitHub extension tests to verify the new adapter boundary and runtime-tool mutation flow.
- [ ] 7.3 Run the project verification suite and confirm the new change is ready for implementation without regressing current GitHub-focused behavior.

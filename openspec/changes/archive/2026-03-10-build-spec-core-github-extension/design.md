## Context

The repository currently implements a workable GitHub-first orchestration platform, but several core behaviors are still expressed in GitHub-specific or product-specific terms. The most important gaps are:

- `WORKFLOW.md` is parsed as a custom sectioned Markdown document instead of the Symphony YAML front matter contract.
- Worker execution is closer to a launcher for `codex app-server` than a Symphony session client that renders prompts, owns turn lifecycle, and manages continuation/retry semantics.
- Workspace preparation is tied to per-run clone directories instead of persistent per-issue workspaces.
- GitHub Project binding, GitHub issue mutation, and approval workflow semantics are mixed into core runtime assumptions instead of layered as optional extensions.

The desired direction is to make the OpenAI Symphony specification the primary system contract, then layer GitHub Project + Issue support and a custom planning/approval workflow as first-party extensions. This preserves product focus while avoiding a permanently GitHub-shaped core.

Stakeholders are:

- operators who need predictable orchestration and recovery behavior
- repository owners who want repo-owned workflow policy in `WORKFLOW.md`
- reviewers who participate in the human approval loop
- future maintainers who need clean boundaries between core runtime logic and GitHub integration logic

## Goals / Non-Goals

**Goals:**

- Make Symphony core behavior tracker-agnostic and spec-conformant.
- Standardize `WORKFLOW.md` around YAML front matter plus prompt body.
- Introduce persistent per-issue workspace lifecycle, hook execution, and reconciliation semantics that match the specification.
- Treat GitHub Project and GitHub Issue support as an adapter and runtime-tool extension.
- Treat planning, approval, implementation, and merge completion as workflow-policy and human-in-the-loop extensions.
- Preserve the current control plane as an optional extension rather than a conformance requirement.

**Non-Goals:**

- Replacing GitHub as the product focus for this repository.
- Designing a generic multi-tracker UI in this change.
- Removing the control plane or brokered credential model.
- Defining every possible future extension point up front beyond the boundaries required for GitHub and human approval support.

## Decisions

### 1. Establish a true Symphony core package boundary

Core orchestration and runtime behavior will be specified in tracker-agnostic terms and extracted into a dedicated `packages/core` package: workflow loading, typed config, workspace lifecycle, prompt rendering, app-server session management, retry, reconciliation, and observability. The target package layout for this change is:

- `packages/core`: Symphony domain model, workflow/config, orchestration state machine, workspace lifecycle, status/log contracts
- `packages/runtime-codex`: Codex app-server runtime driver, session transport, event normalization, runtime-tool bridge
- `packages/tracker-github`: GitHub Project polling, GitHub Issue normalization, project field validation, placement integrity checks, transfer/rebind detection
- `packages/extension-github-workflow`: GitHub-specific planning/review/implementation/awaiting-merge workflow semantics, `github_graphql` contract, handoff verification, issue-closure completion policy
- service/composition layer: thin CLI and runtime wiring layer that composes the core engine with runtime, tracker, and extension implementations

Existing `packages/shared`, `packages/orchestrator`, and `packages/worker` will be reduced, renamed, or split so those responsibilities move into the new Symphony-first boundaries.

Why:

- This matches the upstream specification directly.
- It prevents GitHub-specific semantics from dictating core data structures and lifecycle logic.
- It creates a stable place to test conformance independently of GitHub behavior.

Alternative considered:

- Keep the current GitHub-first core and document divergence.
- Rejected because it locks product assumptions into foundational code and makes future conformance work more expensive.

### 1a. Separate the GitHub tracker adapter from the GitHub workflow extension

The repository will split GitHub support into two explicit packages instead of treating all GitHub logic as one integration surface. `packages/tracker-github` owns issue discovery, normalization, and project placement validation. `packages/extension-github-workflow` owns planning handoff semantics, approval gating, implementation reporting, and issue-closure completion behavior.

Why:

- Tracker read behavior and workflow mutation semantics change at different rates and need independent tests.
- It keeps the tracker adapter reusable even if the GitHub workflow policy changes later.
- It prevents GitHub workflow semantics from leaking back into the generic tracker contract.

Alternative considered:

- Keep GitHub workflow semantics co-located inside the tracker adapter package for the first pass.
- Rejected because the separation is already required by the current design decisions and delaying it would preserve the wrong boundary.

### 1b. Use a spec-shaped internal module tree inside `packages/core`

`packages/core` should mirror the Symphony specification sections instead of mirroring the current repository history. The first-pass internal module tree is:

```text
packages/core/src/
  domain/
    issue.ts
    workflow-definition.ts
    service-config.ts
    workspace-ref.ts
    run-attempt.ts
    live-session.ts
    retry-entry.ts
    runtime-snapshot.ts

  workflow/
    loader.ts
    parser.ts
    config.ts
    validation.ts
    reload.ts
    render.ts

  orchestration/
    engine.ts
    dispatch.ts
    reconciliation.ts
    retry-policy.ts
    claims.ts
    transitions.ts

  workspace/
    identity.ts
    manager.ts
    hooks.ts
    cleanup.ts
    safety.ts

  contracts/
    tracker-adapter.ts
    runtime-driver.ts
    workflow-extension.ts
    status-surface.ts
    log-sink.ts
    state-store.ts

  observability/
    structured-events.ts
    snapshot-builder.ts
    error-catalog.ts

  index.ts
```

Why:

- It aligns code ownership with the Symphony spec sections rather than with the current GitHub-first package history.
- It gives the orchestrator, runtime driver, and extensions a stable import surface.
- It makes conformance-style tests and future tracker/runtime additions easier to place.

Alternative considered:

- Use a flatter `packages/core/src/*` layout and defer internal structure until after refactoring.
- Rejected because the current codebase is already mixed enough that delaying the internal boundary would preserve ambiguity.

### 1c. Migrate current files by concern, not by package name

The current repository files should move according to responsibility, even when that means splitting a file across multiple new modules.

Planned migration map:

```text
packages/shared/src/workflow-parser.ts
  -> packages/core/src/workflow/parser.ts

packages/shared/src/workflow-lifecycle.ts
  -> packages/core/src/workflow/config.ts
  -> packages/extension-github-workflow/src/lifecycle.ts

packages/shared/src/tracker-contract.ts
  -> packages/core/src/domain/issue.ts
  -> packages/core/src/contracts/tracker-adapter.ts

packages/shared/src/github-project-tracker.ts
  -> packages/tracker-github/src/project-client.ts
  -> packages/tracker-github/src/normalize.ts
  -> packages/tracker-github/src/validation.ts

packages/orchestrator/src/types.ts
  -> packages/core/src/domain/*.ts
  -> packages/core/src/contracts/state-store.ts

packages/orchestrator/src/service.ts
  -> packages/core/src/orchestration/engine.ts
  -> packages/core/src/orchestration/dispatch.ts
  -> packages/core/src/orchestration/reconciliation.ts
  -> packages/core/src/orchestration/retry-policy.ts
  -> thin service/composition layer entrypoint

packages/orchestrator/src/fs-store.ts
  -> packages/core/src/contracts/state-store.ts
  -> service/composition layer filesystem adapter

packages/orchestrator/src/git.ts
  -> packages/core/src/workflow/loader.ts
  -> packages/core/src/workspace/manager.ts
  -> implementation-specific repository bootstrap helper outside core as needed

packages/orchestrator/src/tracker-adapters.ts
  -> packages/core/src/contracts/tracker-adapter.ts
  -> packages/tracker-github/src/adapter.ts

packages/orchestrator/src/status-server.ts
  -> thin service/composition layer HTTP/status surface

packages/orchestrator/src/index.ts
  -> thin service/composition layer CLI entrypoint

packages/worker/src/runtime.ts
  -> packages/runtime-codex/src/runtime-plan.ts
  -> packages/runtime-codex/src/tool-bridge.ts

packages/worker/src/local-runtime-launcher.ts
  -> packages/runtime-codex/src/launcher.ts

packages/worker/src/state-server.ts
  -> packages/runtime-codex/src/state-server.ts or service-level debug surface

packages/worker/src/retry-policy.ts
  -> packages/core/src/orchestration/retry-policy.ts

packages/worker/src/github-tracker.ts
  -> packages/tracker-github/src/actionable.ts

packages/worker/src/github-graphql-tool.ts
  -> packages/runtime-codex/src/tools/github-graphql.ts

packages/worker/src/git-credential-helper.ts
  -> packages/runtime-codex/src/tools/git-credential-helper.ts

packages/worker/src/approval-workflow.ts
  -> packages/extension-github-workflow/src/handoff.ts
  -> packages/extension-github-workflow/src/pull-request.ts
  -> packages/extension-github-workflow/src/comments.ts

packages/worker/src/workflow-parser.ts
packages/worker/src/workflow-lifecycle.ts
  -> deleted after imports are redirected to packages/core
```

Notes:

- `packages/shared` should end this change either deleted or reduced to a very small compatibility shim that re-exports from the new package boundaries temporarily.
- The service/composition layer may remain under `packages/orchestrator` briefly during migration, but its end state is wiring only, not domain ownership.

### 2. Treat GitHub Project support as a first-party tracker extension

GitHub Project polling, issue normalization, and GitHub mutation tooling will remain first-class features, but they will sit behind the core tracker adapter and runtime-tool contracts.

Why:

- GitHub remains the primary target without becoming the only legal core shape.
- Adapter boundaries clarify which behaviors are general Symphony semantics and which are GitHub-specific.
- Extension-specific tests become easier to reason about.

Alternative considered:

- Split GitHub support into a separate repository or plugin package immediately.
- Rejected for now because the product remains GitHub-focused and first-party integration still belongs in-tree.

### 3. Treat planning and approval flow as workflow extension, not core orchestration

The planning -> human review -> implementation -> await merge path will be modeled as workflow semantics loaded from `WORKFLOW.md`, with GitHub mutations performed through runtime tools or extension helpers rather than backend-owned business logic.

Why:

- The Symphony specification explicitly keeps tracker mutation on the agent/runtime side by default.
- This allows different repositories to vary workflow states without changing orchestrator fundamentals.
- Human-in-the-loop logic becomes policy, not scheduler behavior.

Alternative considered:

- Make approval states and transitions hard-coded orchestrator behavior.
- Rejected because it would directly conflict with repo-owned workflow policy and degrade portability.

### 4. Rework workspace ownership around issue identity

The canonical workspace directory will be derived from the canonical issue subject identity and reused across attempts. For GitHub, the canonical subject is the GitHub Issue, not the GitHub Project item. GitHub Project items remain the placement and phase source because GitHub Issues alone do not provide the workflow status surface needed for planning, review, implementation, and awaiting-merge states. Run records remain separate orchestration artifacts, but they no longer define the repository checkout location.

Why:

- Persistent per-issue workspaces are required for continuation and lifecycle hooks.
- This aligns with the spec's safety and recovery model.
- It separates long-lived issue state from short-lived run attempts.

Alternative considered:

- Keep per-run clone directories and simulate persistence through snapshots.
- Rejected because it complicates continuation semantics and undermines the spec's workspace model.

### 5. Use layered issue identity instead of a single GitHub-shaped key

The system will track three identities for GitHub-backed work:

- canonical subject identity: `workspace + adapter + issue_subject_id`
- tracker placement identity: `project + project_item_id`
- display identity: `owner/repo#number`

The canonical workspace key and long-lived execution history attach to the issue subject identity. The GitHub Project item is treated as the current placement that supplies workflow state. The display identity is metadata only and may change without changing the canonical workspace key.

Why:

- It matches the product need to use GitHub Project status as the workflow phase source without making the project item the durable identity of the work.
- It keeps planning, implementation, continuation, and cleanup attached to the same issue even if project placement metadata changes.
- It lets the adapter validate project placement and state mapping independently from workspace identity.

Alternative considered:

- Make the GitHub Project item the canonical identity.
- Rejected because completion is determined by issue closure and project placement can change without meaning the underlying work changed.

### 6. Treat GitHub issue transfer as an operator-confirmed rebind

If the GitHub extension detects that a tracked issue appears to have moved to a different repository or otherwise no longer matches its prior canonical aliases, the system will not automatically rewrite canonical identity. Instead it will raise an operator-visible rebind requirement and wait for explicit confirmation before updating aliases or placement bindings.

Why:

- Automatic rebind is risky because GitHub transfer and rebinding signals are not fully controlled by the orchestrator.
- It prevents accidental workspace reuse for the wrong issue after ambiguous tracker changes.
- It keeps the first version operationally safe while leaving room for smarter automation later.

Alternative considered:

- Automatically follow issue transfers and rewrite canonical identity whenever a likely match is observed.
- Rejected because false-positive rebinding would be more damaging than requiring operator confirmation.

### 7. Persist a stable minimal session snapshot, not the full app-server protocol

Core state will persist a stable, transport-agnostic execution snapshot sufficient for reconciliation, retry, continuation, and observability. That snapshot includes identifiers such as workspace, issue, run, execution, attempt, retry kind, session, thread, status, lifecycle timestamps, workflow version/hash, and summarized exit/error classification. Raw app-server events, full transcripts, and transport-specific frame details remain outside the core contract.

Why:

- It gives the orchestrator and control plane a stable internal contract even if app-server internals evolve.
- It keeps recovery and observability machine-readable without freezing the entire subprocess protocol.
- It reduces the amount of state that must survive across worker restarts.

Alternative considered:

- Persist most or all app-server protocol details as canonical orchestration state.
- Rejected because it would over-couple core contracts to an implementation transport.

### 8. Separate continuation, failure, and recovery retries

Retry state will be explicitly typed as continuation retry, failure retry, or recovery retry instead of collapsing all re-entry paths into a single retry bucket. Continuation retry follows normal session exhaustion while the issue remains actionable, failure retry applies exponential backoff to retryable errors, and recovery retry handles crash, lost-heartbeat, or stall recovery.

Why:

- Operators need to distinguish healthy continuation from degraded recovery behavior.
- Retry policy and budget semantics differ across the three paths.
- Status APIs become much easier to interpret.

Alternative considered:

- Represent every re-entry path as a generic retry.
- Rejected because it obscures operator intent and makes policy enforcement ambiguous.

### 9. Keep normal tracker mutation in the runtime, with extension-side verification

The agent/runtime remains responsible for normal GitHub comment, project-state, and pull-request mutation through injected runtime tools such as `github_graphql`. After a run completes, the GitHub extension verifies that the expected handoff mutation actually occurred. If the expected mutation is missing or inconsistent, the system records an explicit operator-visible handoff failure or pending repair state instead of silently advancing workflow state.

Why:

- It preserves the Symphony model in which normal tracker mutation belongs on the runtime side.
- It prevents half-complete handoffs from being mistaken for successful workflow progression.
- It lets the GitHub extension own idempotent repair helpers without pushing GitHub business logic into the core orchestrator.

Alternative considered:

- Move normal post-run GitHub mutation back into orchestrator-owned backend logic.
- Rejected because it would reintroduce GitHub-specific workflow behavior into the core path.

### 10. Treat GitHub Project as the workflow phase source and validate it at the adapter boundary

`WORKFLOW.md` defines semantic phase names and the expected mapping to tracker states, but the GitHub adapter remains responsible for validating that the configured GitHub Project field, option values, and issue-to-project placement shape actually exist and remain coherent. The adapter must also detect duplicate placements or missing placement for an issue that is expected to be phase-managed by GitHub Project.

Why:

- GitHub Issues alone do not provide a reliable workflow status surface for this product.
- Adapter validation catches broken project configuration earlier than policy-only interpretation.
- It keeps tracker-specific integrity checks outside the core orchestration model.

Alternative considered:

- Put all phase and field assumptions into `WORKFLOW.md` policy with no adapter-side validation.
- Rejected because misconfiguration would become too easy to miss until runtime behavior is already incorrect.

### 11. Use issue closure as the canonical completion signal

For the GitHub workflow extension, the canonical completion signal is issue closure. Pull-request merge is a common path to that result, but it is not controlled by the orchestrator and therefore is not by itself sufficient to mark work complete. If merging a pull request does not close the issue automatically, a human or external GitHub automation must close the issue before the orchestrator treats the work as complete and triggers terminal cleanup.

Why:

- It aligns completion with the durable issue subject identity rather than with an implementation artifact.
- It avoids assuming that repository automation always closes issues on merge.
- It keeps the terminal state decision under a signal the orchestrator can observe consistently.

Alternative considered:

- Treat pull-request merge itself as completion.
- Rejected because merged pull requests do not always close the issue and the orchestrator cannot guarantee that side effect.

### 12. Fail closed on `before_remove` hook failures

If the `before_remove` hook fails or times out, the system will not delete the issue workspace. Instead it records a `cleanup_blocked` operator-visible state and requires an explicit retry-cleanup or force-remove action.

Why:

- Workspace deletion is destructive and hard to recover from.
- Repository-owned hooks may perform critical cleanup or export work products.
- Silent cleanup continuation would make failures hard to diagnose.

Alternative considered:

- Warn and continue deleting the workspace after hook failure.
- Rejected because it risks losing state that the hook was intended to protect.

Implementation-profile note:

- The current upstream `docs/symphony-spec.md` draft still describes a more permissive `before_remove` behavior.
- This change intentionally keeps the repository-level implementation profile stricter without editing that upstream draft as part of this work.

### 13. Freeze running sessions to a launch-time workflow snapshot

Running sessions use the effective workflow snapshot captured at launch. Updated valid workflow config applies only to future poll ticks, future hook executions, and future launches or relaunches. Invalid updates never replace the effective configuration; the last known valid workflow remains authoritative until a new valid version is available.

Why:

- It prevents mid-session policy drift inside a single execution.
- It still allows operators to change future scheduling, retry, and hook behavior without restart.
- It makes runtime reload behavior predictable and testable.

Alternative considered:

- Apply workflow updates immediately to already-running sessions.
- Rejected because it would create inconsistent semantics inside a single execution attempt.

### 14. Keep control plane compatibility through translation, not ownership

The control plane should provision workspace metadata and optional broker endpoints, but it should not own the canonical runtime contract. It may generate or validate `WORKFLOW.md` defaults, yet the repository remains the source of truth for workflow semantics.

Why:

- This preserves the optional nature of the control plane.
- It prevents generated artifacts from becoming stale copies of policy.
- It reduces drift between repository state and runtime behavior.

Alternative considered:

- Continue using control-plane-generated workflow artifacts as the primary contract.
- Rejected because it conflicts with the repo-owned workflow objective and with spec conformance.

## Risks / Trade-offs

- [Migration complexity] Existing GitHub-first runtime paths depend on generated workflow artifacts and run-scoped directories. -> Mitigation: stage the migration behind compatibility loaders and move one contract at a time.
- [Temporary duplication] Core and extension paths may coexist while code is being refactored. -> Mitigation: define explicit deprecation checkpoints in the task plan.
- [Behavior drift] Existing archived specs are GitHub/product-oriented and may not map cleanly onto the new core boundary. -> Mitigation: update affected specs in the same change so implementation and archive history stay aligned.
- [Operator friction] Workflow ownership moving into repositories can expose previously hidden setup assumptions. -> Mitigation: document bootstrap defaults and provide compatibility validation in the control plane.
- [Test churn] Conformance-style tests will invalidate several current assumptions. -> Mitigation: create a new core conformance test layer before replacing the existing GitHub-specific tests.

## Migration Plan

1. Introduce the new core capability and update the affected specs to define the new boundaries.
2. Refactor the workflow parser and typed config layer to support YAML front matter while preserving a temporary compatibility path for current generated workflow files.
3. Move workspace ownership from run-scoped clones to issue-scoped persistent directories.
4. Update the worker runtime to own prompt rendering, session lifecycle, and continuation/retry semantics.
5. Move GitHub polling and mutation behavior behind the tracker adapter and runtime-tool extension boundaries.
6. Update the control plane so it provisions metadata and validates workflow compatibility instead of owning the canonical workflow contract.
7. Remove transitional compatibility behavior once the new core path is stable.

Rollback strategy:

- Preserve the current GitHub-first behavior behind a compatibility mode until the new core path passes conformance and integration verification.
- If deployment problems appear, operators can fall back to the compatibility path while preserving workspace metadata and GitHub bindings.

## Resolved Design Notes

- Compatibility with the current sectioned Markdown `WORKFLOW.md` format remains as a temporary runtime fallback during migration and is removed after the new YAML-front-matter path is stable.
- The first implementation pass includes a dedicated `packages/core` extraction and explicit `packages/runtime-codex`, `packages/tracker-github`, and `packages/extension-github-workflow` package boundaries.
- App-server integration is represented in stable internal types only through a minimal execution snapshot and transport-agnostic lifecycle contract.
- GitHub Project remains the source of workflow phase information because pure GitHub Issue state is insufficient for the desired workflow model.

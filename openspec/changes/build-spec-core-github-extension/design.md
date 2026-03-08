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

Core orchestration and runtime behavior will be specified in tracker-agnostic terms: workflow loading, typed config, workspace lifecycle, prompt rendering, app-server session management, retry, reconciliation, and observability.

Why:

- This matches the upstream specification directly.
- It prevents GitHub-specific semantics from dictating core data structures and lifecycle logic.
- It creates a stable place to test conformance independently of GitHub behavior.

Alternative considered:

- Keep the current GitHub-first core and document divergence.
- Rejected because it locks product assumptions into foundational code and makes future conformance work more expensive.

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

The canonical workspace directory will be derived from the sanitized issue identifier and reused across attempts. Run records remain separate orchestration artifacts, but they no longer define the repository checkout location.

Why:

- Persistent per-issue workspaces are required for continuation and lifecycle hooks.
- This aligns with the spec's safety and recovery model.
- It separates long-lived issue state from short-lived run attempts.

Alternative considered:

- Keep per-run clone directories and simulate persistence through snapshots.
- Rejected because it complicates continuation semantics and undermines the spec's workspace model.

### 5. Keep control plane compatibility through translation, not ownership

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

## Open Questions

- Should compatibility with the current sectioned Markdown `WORKFLOW.md` format be temporary runtime fallback behavior or a one-time migration tool only?
- How much of the app-server protocol should be represented in stable internal types versus a thinner transport wrapper?
- Should GitHub Project item status mapping live entirely in workflow policy, or should the GitHub extension retain a small amount of adapter-level validation for expected state fields?
- Do we want a dedicated `packages/core` extraction in this change, or should the first pass stay within the current package layout and enforce boundaries via modules and specs first?

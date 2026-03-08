# AGENT.md

## Project Identity

This repository is an implementation of OpenAI Symphony as described in [docs/symphony-spec.md](docs/symphony-spec.md).

The upstream specification is the source reference for architecture, layering, orchestration behavior, runtime behavior, workflow loading, workspace lifecycle, tracker integration boundaries, and observability expectations.

## Mandatory Pre-Work Checks

Before writing or changing any spec, design, or implementation artifact, the agent MUST identify:

1. Which Symphony spec layer the work belongs to.
2. Whether the work affects one layer only or crosses multiple layers.

Use the layer model from the Symphony spec:

1. Policy Layer
2. Configuration Layer
3. Coordination Layer
4. Execution Layer
5. Integration Layer
6. Observability Layer

When starting work, explicitly classify the task against one or more of these layers.

## Mandatory Post-Work Checks

After completing any spec or implementation task, the agent MUST verify:

1. Whether the resulting design or code still conforms to [docs/symphony-spec.md](docs/symphony-spec.md).
2. Whether any part of the work intentionally diverges from the upstream spec.

If a divergence exists:

- The divergence must be called out explicitly in the relevant change proposal, design, task, or implementation notes.
- The divergence must be treated as a repository-level implementation choice, not as an implicit rewrite of the upstream spec.
- The divergence must not be hidden behind ambiguous wording.

## Hard Rule: Do Not Modify The Upstream Spec

The file [docs/symphony-spec.md](docs/symphony-spec.md) is the upstream source specification.

Agents MUST NOT edit, rewrite, patch, or reformat that file as part of normal spec work or implementation work.

If a proposed design appears to conflict with the upstream spec:

- Do not modify the upstream spec file.
- Keep the divergence in repository-local design/change documents instead.
- Make the divergence explicit and reviewable.

## Spec And Implementation Discipline

When proposing or implementing changes:

- Prefer aligning the repository to the upstream Symphony spec rather than redefining core behavior locally.
- Keep tracker-specific behavior out of core layers unless the upstream spec clearly allows that boundary.
- Keep workflow-policy behavior separate from orchestration-core behavior.
- Treat GitHub-specific semantics as repository extensions layered on top of Symphony core behavior.

## Applies To

These rules apply to:

- OpenSpec proposals, designs, tasks, and capability specs
- package structure changes
- runtime/orchestrator/tracker integration work
- workflow/config changes
- implementation and refactoring work

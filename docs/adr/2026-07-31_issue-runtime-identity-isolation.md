# Issue runtime identity isolation

## Context

A worker run owns one canonical issue, but the rendered workflow prompt previously did not have to name that issue. Continuation and dirty-workspace recovery guidance were also issue-anonymous. A coding agent could therefore discover and adopt a different actionable issue while remaining inside the original issue workspace.

## Decision

The coordination layer prepends an engine-owned issue identity envelope to every rendered initial or recovery prompt. The execution layer applies the same envelope to continuation turns and rejects startup when the workspace key, workspace/repository boundary, Git origin, or expected linked-PR branch does not match the orchestrator-owned values.

Codex command and file-change item events are checked against the repository boundary. A boundary violation interrupts the turn and fails the worker. The worker also rejects a branch that explicitly identifies a different issue. Event logs emit cwd values in a separate complete field rather than relying only on a truncated parameter preview.

An incomplete-turn dirty workspace is reusable only when its current branch can be attributed to the run issue (the linked PR head branch or an issue-number-bearing branch). Otherwise the orchestrator renames the issue workspace to a quarantine path, records a structured quarantine event, creates a clean workspace, and omits the commit-and-push recovery instruction.

## Specification alignment

Workspace and event boundary validation implements Symphony specification §9.5 invariants 1 and 2. The issue identity envelope intentionally extends §10.2's rendered prompt input, and quarantine is the repository's explicit §9.3 reset policy. These are repository-level safety choices; `docs/symphony-spec.md` remains unchanged.

## Consequences

Unattributed dirty work is preserved under a quarantine path for operator inspection but is never offered to an agent for automatic commit or push. Branch attribution is deliberately fail-closed during recovery; repositories that use issue-number-free branches must expose the linked PR head branch through tracker metadata for recovery reuse.

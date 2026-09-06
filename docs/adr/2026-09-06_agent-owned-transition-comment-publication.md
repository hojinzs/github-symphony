# ADR: Keep transition-comment publication agent-owned

- **Date**: 2026-09-06
- **Status**: Accepted
- **Supersedes**: [2026-08-07_orchestrator-transition-comment-publication.md](2026-08-07_orchestrator-transition-comment-publication.md)
- **Related Issue**: #907
- **Related Spec**: `docs/symphony-spec.md` §11.5, §2.2

## Context

The superseded decision made the orchestrator publish a workflow-defined
`🔁 Status` comment after confirming a tracker transition. That coupled the
coordination and tracker-integration layers to a presentation rule that is not
part of Symphony's product contract: workflows may omit transition comments or
choose a different format.

Removing the orchestrator publisher while continuing to accept `comment_body`
would silently discard an agent's report. The transition-intent API therefore
needs a clear boundary as ownership moves back to the workflow.

## Decision

The tracker-state API accepts only transition intent: expected state, target
state, and reason. It explicitly rejects `comment_body` instead of accepting and
discarding it. After confirmed exact-state readback, a workflow that wants a
transition comment publishes its prepared body through an agent-owned tracker
tool such as `github_graphql`.

The orchestrator and `OrchestratorTrackerAdapter` expose no transition-comment
publication methods, outcomes, or provider mutations. Workflow instructions and
tracked runtime skills define any desired comment format and ordering.

## Layer impact

| Layer         | Impact | Decision                                                                 |
| ------------- | ------ | ------------------------------------------------------------------------ |
| Policy        | Yes    | Workflows decide whether and how agents publish transition comments.     |
| Coordination  | Yes    | The tracker-state API confirms state only and rejects comment payloads.  |
| Integration   | Yes    | Orchestrator tracker adapters no longer expose comment-write capability. |
| Observability | Yes    | Run snapshots no longer contain transition-comment publication outcomes. |

## Upstream conformance

This restores the upstream §11.5 default boundary in which tracker writes are
agent-tool owned and preserves §2.2 separation between workflow policy and
orchestration mechanics. There is no repository-local divergence, and
`docs/symphony-spec.md` remains unchanged.

## Consequences

- Different workflows may omit transition comments or use different formats.
- A confirmed transition and an agent-authored comment remain separate
  operations; workflow and harness design own their sequencing and recovery.
- Legacy `comment_body` requests fail loudly instead of losing reports.
- Approval-workflow and blocker comments remain agent/extension-owned and are
  unaffected.

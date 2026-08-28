# ADR: Keep GitHub linked-PR canonical subjects in the tracker adapter

- **Date**: 2026-08-28
- **Status**: Accepted
- **Related Issue**: #665
- **Related Spec**: `docs/symphony-spec.md` §4.2, §11.2

## Context

GitHub Project V2 may expose both an Issue card and a linked pull-request card.
The repository treats the Issue as the canonical dispatch subject while using the
linked PR card's Project state for review and advisory behavior. This is a
GitHub extension, not a portable tracker payload shape.

Previously `OrchestratorService` read GitHub `metadata` and `tracker.itemId`
directly to merge those cards. That made Coordination depend on provider payload
semantics and conflicted with the specification's opaque `native_ref` boundary.

## Decision

`TrackedIssue.nativeRef` carries non-secret, JSON-safe provider identity data.
The orchestrator does not inspect it. Tracker adapters expose canonicalization,
identifier matching, tracker-item lookup, checkout target, and linked-PR active
facts through `OrchestratorTrackerAdapter` hooks instead.

GitHub's `resolveCanonicalIssues` hook remains responsible for merging a linked
PR card into its Issue subject. `metadata` is retained as deprecated
compatibility input for third-party adapters during migration; new orchestration
logic must use adapter hooks and `nativeRef` rather than provider metadata.

## Upstream conformance and divergence

This conforms to the upstream opaque-native-reference boundary. GitHub
linked-PR canonicalization is an explicit repository extension layered at the
Integration boundary; it does not alter `docs/symphony-spec.md`.

## Consequences

- Core and Coordination remain provider-payload agnostic.
- New trackers can supply native references without emulating GitHub metadata.
- Adapter authors migrating from legacy metadata retain a compatibility window.

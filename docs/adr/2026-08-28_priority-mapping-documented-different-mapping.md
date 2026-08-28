# ADR: Documented Different Dispatch-Priority Mapping

- **Date**: 2026-08-28
- **Status**: Accepted
- **Supersedes**: `docs/adr/2026-05-18_explicit-dispatch-priority-mappings.md`
- **Related Issue**: #725
- **Related Spec**: `docs/symphony-spec.md` §8.2 and §11.3 (read-only)

## Context

The upstream specification orders eligible candidates by priority before
creation time and identifier. It does not require a particular tracker-level
numeric mapping. The earlier ADR proposed a GitHub-specific, explicit priority
configuration and adapter behavior that is not the repository's current
implementation.

## Decision

github-symphony retains its current documented different mapping:

1. Every finite integer priority sorts in ascending numeric order; lower is
   dispatched first.
2. `null` and non-integer priority values sort after every integer priority.
3. Within either group, the existing creation-time and identifier tie-breakers
   remain unchanged.
4. Linear priority value `0` is normalized to `null`; it is not treated as the
   highest priority.

This is a repository-local implementation choice and an explicit divergence in
mapping, not a change to the upstream specification. It applies to the values
already supplied to the dispatch sorter; this ADR does not introduce a new
priority configuration format or change tracker-adapter behavior.

## Consequences

- Dispatch ordering remains stable and reviewable without inventing a mapping
  for tracker values that are absent or non-integral.
- The proposed `tracker.priority` configuration, GitHub-specific resolution,
  and observability work in the superseded ADR are not adopted by this decision.
- Adapter-level timestamp and priority normalization remains separately scoped;
  this change only adds shared core helpers and documentation.

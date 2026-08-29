# ADR: Documented Different Dispatch-Priority Mapping

- **Date**: 2026-08-28
- **Status**: Accepted
- **Related ADR**: `docs/adr/2026-05-18_explicit-dispatch-priority-mappings.md`
- **Related Issue**: #725
- **Related Spec**: `docs/symphony-spec.md` §8.2 and §11.3 (read-only)

## Context

The upstream specification orders eligible candidates by priority before
creation time and identifier. It does not require a particular tracker-level
numeric mapping. The related 2026-05-18 ADR defines how the GitHub adapter
derives a priority from explicit tracker configuration. This ADR is orthogonal:
it records how the dispatch sorter orders those already-derived values.

## Decision

github-symphony retains its current documented different mapping:

1. Every numeric priority, including non-integers, sorts in ascending numeric order; lower is
   dispatched first.
2. `null` sorts after every numeric priority.
3. Within either group, the existing creation-time and identifier tie-breakers
   remain unchanged.

This is a repository-local implementation choice and an explicit divergence in
mapping, not a change to the upstream specification. It applies to the values
already supplied to the dispatch sorter; this ADR does not introduce a new
priority configuration format or change tracker-adapter behavior.

## Pending implementation

Linear priority value `0` ("No priority") will be normalized to `null` rather
than treated as the highest priority. The Linear adapter currently passes `0`
through, so it currently sorts before positive values; adapter adoption is
tracked in #660-B.

## Consequences

- Dispatch ordering remains stable and reviewable without redefining tracker
  priority derivation or inventing a mapping for absent values.
- The related priority-mapping ADR and its configuration, adapter resolution,
  and observability behavior remain in effect.
- Adapter-level timestamp and priority normalization remains separately scoped;
  this change only adds shared core helpers and documentation.

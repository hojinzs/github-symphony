# ADR: Retain flat tracker keys as deprecated provider aliases

> **Superseded (2026-09-02):** The next-major removal tracked by #679 is
> complete. Flat tracker keys now fail with `workflow_deprecated_key`.
> `gh-symphony doctor` retains a copyable `tracker.provider` migration block.

- **Date**: 2026-08-29
- **Status**: Accepted
- **Related Issues**: #669, #679, #710
- **Related Spec**: `docs/symphony-spec.md` §5.3.1, §6.1 (read-only)

## Context

The upstream configuration model places adapter-owned tracker settings in the
opaque `tracker.provider` object. Existing GitHub Symphony workflows used flat
`tracker.*` keys such as `project_id`, `endpoint`, `state_field`, `priority`,
and `pickup_labels`. Removing those keys immediately would break committed
workflows and installed repository runtimes.

## Decision

New generated workflows, reference workflows, and skill templates use
`tracker.provider`. The parser continues to promote supported flat tracker keys
into that provider object as deprecated, non-breaking aliases. Diagnostics from
`gh-symphony workflow validate` and `gh-symphony repo doctor` identify the
aliases and print a copyable normalized provider block.

The aliases are scheduled for removal in the next major release. The removal
work is tracked separately in #679 and must not begin before its required sign
off.

## Upstream conformance and divergence

Provider-form configuration aligns with the upstream specification. Retaining
flat aliases is an intentional, time-bounded repository compatibility extension
rather than an upstream-spec change. `docs/symphony-spec.md` remains
unchanged.

## Consequences

- Newly initialized repositories follow the provider-owned configuration
  boundary without migration work.
- Existing repositories keep working while operators migrate using doctor
  output.
- Documentation consistently labels flat keys as deprecated and directs new
  configuration to `tracker.provider`.

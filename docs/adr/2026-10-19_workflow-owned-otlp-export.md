# ADR: Workflow-owned, orchestrator-local best-effort OTLP export

- **Date**: 2026-10-19
- **Status**: Accepted
- **Related Issue**: #998; tracking Epic #794
- **Approval**: [approved design PR #986](https://github.com/hojinzs/github-symphony/pull/986), registered scope at `8a144a8898aae19cb002709adb786e33dd2c184b`; [release acceptance PR #1091](https://github.com/hojinzs/github-symphony/pull/1091)
- **Symphony Layers**: Configuration, Observability
- **Related Spec**: `docs/symphony-spec.md` §§13.2, 13.3, 14.2, 17.6, 18.2

## Context

Upstream permits remote sinks and monitoring while requiring independent correct
orchestration. It does not prescribe OTLP, this YAML block, process resources,
queue bounds, restart-required transport or metric names. Operators need an
optional remote view without making delivery or scheduling depend on a receiver.

## Decision

Reserve `observability.otlp` in the Configuration Layer. Implement Logs and
Metrics as Observability consumers of authoritative Coordination state, with
orchestrator-owned isolated official SDK providers, HTTP/protobuf exporters and
protected child environments. Explicit YAML `enabled: true` is required; an
endpoint alone never enables export. No global SDK provider or agent-native OTel
inheritance is installed. Workers and hooks receive no exporter credentials.

Publication follows successful durable event append and committed snapshots.
Offers are bounded and do not await transport; exporter failure cannot fail or
delay dispatch/reconciliation. Local durable events and state remain authoritative.
Transport, credentials and resources are frozen by the project owner; valid edits
are pending until restart, including disable edits. Exporter diagnostics stay
separate from coordination health and never recursively export themselves.

This is an explicit repository-local extension, not a normative replacement or
new upstream conformance prerequisite. Existing local lifecycle/security choices
remain in force, including recovery from an initially invalid workflow. No
upstream specification text is changed.

## Consequences and alternatives

Best-effort export can lose records on queue saturation, request failure, shutdown
timeout or forced death. Shutdown shares at most five seconds across both signals;
there is no historical replay, backfill or delivery guarantee. SDK dependencies
increase package size; the retained package/performance acceptance measures that
cost rather than claiming zero overhead.

Rejected first-release alternatives are environment-only activation, direct JSON
transport, a wholesale durable-sink refactor and traces. Traces, Claude token
support, agent OTel inheritance, extra metrics and new UI remain separate future
work; none is a prerequisite for the fixed Epic closure scope.

See the [operator contract](../configuration.md#otlp-workflow-policy) and
[release verification](../reports/2026-10-19-otlp-release-verification.md).

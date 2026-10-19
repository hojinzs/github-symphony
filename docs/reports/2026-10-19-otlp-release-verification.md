# OTLP first-release verification (#998)

Layers: Configuration and Observability. This record consolidates delivered
behavior; it does not authorize a new dogfood run, change production settings or
close the tracking Epic. The documentation closeout itself awaits merge of #998.

## Approved first-release checklist

- [x] Approved Logs/Metrics scope and local extension decision: [design PR #986](https://github.com/hojinzs/github-symphony/pull/986), pinned registration head `8a144a8898aae19cb002709adb786e33dd2c184b`; [accepted ADR](../adr/2026-10-19_workflow-owned-otlp-export.md).
- [x] Configuration, normalization, projections and measured-token provenance: [#987](https://github.com/hojinzs/github-symphony/issues/987), [#988](https://github.com/hojinzs/github-symphony/issues/988), [#989](https://github.com/hojinzs/github-symphony/issues/989), [#990](https://github.com/hojinzs/github-symphony/issues/990).
- [x] Worker credential exclusion, durable publication and bounded Logs/Metrics pipelines: [#991](https://github.com/hojinzs/github-symphony/issues/991), [#992](https://github.com/hojinzs/github-symphony/issues/992), [#993](https://github.com/hojinzs/github-symphony/issues/993), [#994](https://github.com/hojinzs/github-symphony/issues/994).
- [x] Lifecycle, CLI diagnostics, packed CLI audits and explicit enablement: [#995](https://github.com/hojinzs/github-symphony/issues/995), [#996](https://github.com/hojinzs/github-symphony/issues/996).
- [x] OT-14 independently attributable Collector receipt and outage behavior: [#997](https://github.com/hojinzs/github-symphony/issues/997) / [merged PR #1059](https://github.com/hojinzs/github-symphony/pull/1059). The runnable `otlp-collector` scenario and artifact paths are documented in [AGENT_TEST.md](../../AGENT_TEST.md).
- [x] OT-15 supervised dependency-ready delivery, dispatch identity and parent exclusion: [evidence record](2026-10-18-otlp-ot15-dogfood-evidence.md) / [merged PR #1086](https://github.com/hojinzs/github-symphony/pull/1086), tracked by [#1077](https://github.com/hojinzs/github-symphony/issues/1077). This proves delivery, independently of Collector receipt.
- [x] Release activation acceptance: [#1084 / merged PR #1091](https://github.com/hojinzs/github-symphony/pull/1091), [decision and independent platform results](2026-10-19-otlp-release-acceptance.md), [policy evidence](2026-10-19-otlp-release-policy-evidence.json). Both current-candidate platform series pass the explicit owner-revised median/series policy. Historical failed gates remain unchanged and are superseded, not relabelled passing. Native historical offer data contains count/p95 only; new Linux audits retain raw offer timings.
- [x] Consolidated operator references, loss expectations, support/cardinality examples and accepted ADR are supplied by this documentation change. Upstream spec remains unchanged. No release Changeset is required by #998's registration policy.

## Release usage and remaining boundary

Export remains disabled by default. The shipped CLI supplies the internal
production capability; normal workflow `enabled: true` enables the complete
pipeline after validation. Library owners retain the default rejection guard.
Acceptance approval does not turn on an operator's project or introduce an
activation override. Follow [configuration](../configuration.md#otlp-workflow-policy)
and [CLI diagnostics](../../packages/cli/README.md#otlp-diagnostics); restart after
transport edits. Empty doctor probes prove connectivity, not real exported receipt.

The original [design](../designs/2026-10-04-otlp-export-design.md) and
[delivery plan](../designs/2026-10-04-otlp-export-dogfood-plan.md) retain historical
proposal wording. Their release status points here; the later owner-approved
acceptance policy supersedes the original startup-p95 gate. No new traces, Claude
token support, UI, agent inheritance, extra metrics or new sub-issues are required.
Epic closure still requires this documentation PR to merge and the operator to
review the separately linked delivery and receipt records.

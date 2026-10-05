# @gh-symphony/core

Tracker-agnostic Symphony core contracts, workflow loading, orchestration types, workspace types, and observability-facing status surfaces.

The public barrel exports `getEventSeverity` and `normalizeEventForExport` for SDK-free structured event projection. Supply the redacted append event and an `EventAppendContext` containing observed ISO time, optional project/run fallback IDs and integrity. Event payload and extracted values are preserved without re-redaction; the mapper redacts caller-supplied append context separately. The result is either an `ExportEventRecord` (millisecond timestamps, severity, bounded redacted attributes) or an explicit mapping failure. The helper performs no persistence, tracker reads or transport work; it preserves local event schemas and does not activate OTLP. See the [Observability layer](../../docs/architecture.md#6-observability--events-and-status-surfaces) for omission and payload limits.

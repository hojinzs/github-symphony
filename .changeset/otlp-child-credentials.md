---
"@gh-symphony/cli": patch
---

Protect OTLP exporter credentials at orchestrator worker and hook boundaries, rejecting shared agent/tracker auth names even when export is disabled (#991).

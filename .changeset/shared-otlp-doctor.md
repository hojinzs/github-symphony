---
"@gh-symphony/cli": patch
---

Share SDK-free OTLP runtime validation with doctor and show safe actionable remediation without credential values (#1053).

Exporter credential ownership conflicts now report a fixed value-free message at `observability.otlp` instead of naming the conflicting environment variable at `observability.otlp.headers`. Consumers matching the previous validation path or message must update their handling.

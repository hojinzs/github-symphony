---
"@gh-symphony/cli": patch
---

Freeze OTLP exporter settings at startup and expose safe applied/pending restart diagnostics. Bound concurrent Logs/Metrics shutdown to one five-second deadline while keeping exporter failures separate from coordination health. Production activation remains gated pending packaged audits (#995).

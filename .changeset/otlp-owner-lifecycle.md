---
"@gh-symphony/cli": patch
---

Freeze OTLP exporter settings from the first usable workflow and expose safe applied/pending restart diagnostics. Bound concurrent Logs/Metrics shutdown to one five-second deadline while keeping exporter failures separate from coordination health. Production activation remains gated pending packaged audits, and rejected startup exits once with code 1 instead of retrying (#995).

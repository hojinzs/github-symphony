---
"@gh-symphony/cli": patch
---

Freeze OTLP exporter settings from the first usable workflow and expose safe applied/pending restart diagnostics. Bound concurrent Logs/Metrics shutdown to one five-second deadline while keeping exporter failures separate from coordination health. Production activation remains gated pending packaged audits, and rejected startup exits once with code 1 instead of retrying (#995).

Any error escaping continuous-mode startup now drains the service, releases its lock and exits with code 1 instead of retrying; a process supervisor is responsible for restarting it.

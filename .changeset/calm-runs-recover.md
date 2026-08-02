---
"@gh-symphony/cli": patch
---

Prevent stale-run recovery from creating duplicate workers or leaving issue #517 runs falsely active, and make daemon/status process reconciliation safe across PID reuse and stale PID files.

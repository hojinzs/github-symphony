---
"@gh-symphony/cli": patch
---

Add expected-target project stop arguments that reject replaced or unverified processes without signals or record deletion, and use a private local shutdown endpoint to prevent PID reuse from redirecting graceful stop. Restart existing daemons with the new CLI before using this mode. Implements #1006 (Epic #983).

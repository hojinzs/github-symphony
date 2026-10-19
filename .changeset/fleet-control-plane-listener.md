---
"@gh-symphony/cli": patch
---

Add `gh-symphony control-plane run --config <file>` with a private fleet HTTPS listener, strict TLS/proxy configuration, browser and agent authentication boundaries, readiness and graceful shutdown. Preserve environments across restart and accept zero-project agent first signals (#1089).

Bound enrollment requests and avoid repeated parsing of large agent inventories to keep the listener responsive.

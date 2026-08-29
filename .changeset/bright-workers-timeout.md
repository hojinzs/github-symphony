---
"@gh-symphony/cli": patch
---

Make Codex turn timeouts measure app-server silence rather than total runtime, and reject unsupported approval policies before they can stall a worker session (#658).

Workflows that set `codex.approval_policy` to `on-request` or `untrusted` must change it to `never` or remove the setting before upgrading.

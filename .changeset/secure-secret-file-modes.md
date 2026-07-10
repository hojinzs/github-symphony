---
"@gh-symphony/cli": patch
---

Harden token cache and Claude MCP runtime config writes for #443 by forcing secret files to `0600` and dedicated parent directories to `0700`.

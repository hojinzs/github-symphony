---
"@gh-symphony/cli": patch
---

Reuse each reconciliation cycle's project item snapshot for active-run state synchronization, removing the duplicate by-ID tracker lookup for #478.

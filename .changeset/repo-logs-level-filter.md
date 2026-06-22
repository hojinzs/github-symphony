---
"@gh-symphony/cli": patch
---

Fix `gh-symphony repo logs --level` to derive levels from structured event types, include turn failures in error results, validate unsupported level values, and report empty filtered results clearly for issue #386.

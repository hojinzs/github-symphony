---
"@gh-symphony/cli": patch
---

Keep GitHub Project dispatch alive under shared-token GraphQL pressure by
turning low positive remaining budget into graceful polling degradation instead
of a hard reset-window dead zone. References #427.

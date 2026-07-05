---
"@gh-symphony/cli": patch
---

Reduce GitHub GraphQL rate-limit dispatch dead zones by allowing positive
remaining budget to continue polling while scaling the orchestrator poll
interval continuously as token headroom drops. Documents token separation for
co-hosted repository orchestrators. Refs #427.

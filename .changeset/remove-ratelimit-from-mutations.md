---
"@gh-symphony/cli": patch
---

Remove the invalid `rateLimit` selection from GitHub GraphQL mutation documents (project item state transition, add/update issue comment). GitHub only defines `rateLimit` on the Query type, so every orchestrator-owned `Ready → In progress` transition failed schema validation with `Field 'rateLimit' doesn't exist on type 'Mutation'`. Mutation rate-limit telemetry now relies on the `x-ratelimit-*` response headers instead of an in-body field, and per-cycle GraphQL cost no longer counts a field-reported mutation cost.

---
"@gh-symphony/cli": patch
---

Harden HTTP refresh input and Linear pagination for issue #468. As an explicit
repository policy that diverges from the upstream configured-cadence behavior,
workflow polling inputs are clamped to 1 second–5 minutes: smaller values run
every second and larger values run every 5 minutes, while adaptive rate-limit
backoff may still schedule a longer delay.

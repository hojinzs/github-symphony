---
"@gh-symphony/cli": patch
---

Add durable management-agent command execution and process reconciliation (#1012,
Epic #983). Persist claim/effect/result evidence, retry lost result acknowledgments,
and recover interrupted lifecycle commands without repeating effects or signaling
replacement orchestrators. Expose the executor and journal through the bundled
management-agent module and compose delivery under the foreground owner lock.

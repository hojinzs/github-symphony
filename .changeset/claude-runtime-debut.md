---
"@gh-symphony/cli": patch
---

Add Claude as a first-class agent runtime alongside Codex. The CLI now lets you pick a runtime during `init`, runs Claude preflight checks (auth, broker probe), and ships a `claude -p` spawn-loop adapter with session-id persistence, stream-json event mapping, prompt constraints, and a composed GitHub GraphQL MCP config. Worker agent events are normalized to runtime-neutral names and the workflow `runtime` block is parsed in core.

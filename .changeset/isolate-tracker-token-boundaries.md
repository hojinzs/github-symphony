---
"@gh-symphony/cli": minor
---

Keep raw GitHub tracker-token aliases out of Codex and Claude coding-agent
environments, and prevent Claude-generated MCP configuration from storing them.
This implements the Phase 1a boundary from #672 while retaining the existing
GitHub broker compatibility path.

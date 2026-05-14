---
"@gh-symphony/cli": patch
---

Keep Symphony-managed Claude MCP config in the issue runtime directory so retries do not fail on a generated workspace `.mcp.json` dirty status. Fixes #325.

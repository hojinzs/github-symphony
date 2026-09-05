---
"@gh-symphony/cli": patch
---

Remove the agent-provider credential broker and cache plumbing. Codex now uses direct OpenAI environment credentials or staged local login, while bare Claude runtimes require a direct `ANTHROPIC_API_KEY` (#904).

---
"@gh-symphony/cli": patch
---

Stop forcing Codex app-server workers for #378 into a staged `.codex-agent` home by default, so local runs consistently use the caller's normal Codex home unless `CODEX_HOME` is explicitly provided.

---
"@gh-symphony/cli": patch
---

Add runtime selection to `gh-symphony setup` so issue #390 users can choose Codex or Claude Code during onboarding, pass `--runtime` in non-interactive setup, and receive a clear install hint when the selected runtime command is missing from `PATH`.

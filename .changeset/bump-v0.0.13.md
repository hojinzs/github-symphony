---
"@gh-symphony/core": patch
"@gh-symphony/orchestrator": patch
"@gh-symphony/worker": patch
"@gh-symphony/runtime-codex": patch
"@gh-symphony/tracker-github": patch
"@gh-symphony/extension-github-workflow": patch
"@gh-symphony/cli": patch
"@gh-symphony/tracker-file": patch
---

Bump all packages to v0.0.13

- fix(core): validate template variables before substitution to prevent false strict-mode errors when substituted values (e.g. issue descriptions) contain mustache-like patterns

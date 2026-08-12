---
"@gh-symphony/cli": patch
---

Compose layered MCP sidecars safely for Claude and Codex runtimes (#568).

When `runtime.isolation.trust_repo_config` is `false` (the default), Claude
disables MCP auto-discovery to prevent untrusted repository commands from
running. Move trusted user-wide servers to `~/.gh-symphony/mcp.json`, or set
`runtime.isolation.trust_repo_config: true` to explicitly load a repository
sidecar.

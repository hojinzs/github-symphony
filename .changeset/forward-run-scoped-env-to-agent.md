---
"@gh-symphony/cli": patch
---

Forward run-scoped orchestrator context (`SYMPHONY_ORCHESTRATOR_URL`, `SYMPHONY_RUN_ID`, `SYMPHONY_ORCHESTRATOR_TOKEN`) through the Codex runtime plan so the agent-side `/gh-project` skill can authenticate tracker state reads and transition requests. The orchestrator injected these into the worker process since #502, but the codex app-server environment allowlist stripped them, so every run fail-closed on its first Project transition.

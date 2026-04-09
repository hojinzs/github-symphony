---
"@gh-symphony/cli": patch
---

Add upgrade, setup, repo sync, start --once, and doctor --fix commands with various bug fixes for token auth, assigned-only flags, and orchestrator redispatch

### New Commands
- `upgrade`: self-upgrade CLI
- `setup`: one-command setup flow
- `repo sync`: sync repository configurations
- `start --once`: single-run mode
- `doctor --fix`: auto-remediation mode
- `init --dry-run`: preview mode before initialization
- workflow authoring commands

### Bug Fixes
- Fix token fallback validation and env token priority in interactive auth
- Fix assigned-only flag preservation in interactive setup
- Fix repo sync prune order
- Fix orchestrator redispatch for re-entered active issues
- Fix doctor to fail fast when git probe breaks

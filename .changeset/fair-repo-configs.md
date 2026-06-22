---
"@gh-symphony/cli": patch
---

Fix issue #389 so `gh-symphony repo` subcommands honor the documented global `--config` / `GH_SYMPHONY_CONFIG_DIR` runtime override instead of silently falling back to the cwd repo runtime.

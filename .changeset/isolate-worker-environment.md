---
"@gh-symphony/cli": patch
---

Prevent repository-root `.env` files from leaking into worker processes by launching workers from their run-scoped directory and limiting managed environment loading to the configured project source (#810).

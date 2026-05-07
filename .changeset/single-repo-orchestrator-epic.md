---
"@gh-symphony/cli": patch
"@gh-symphony/control-plane": patch
---

BREAKING: complete the single-repository orchestrator transition. Runtime
state is now repo-local, project routing is no longer part of the public status
surface, project configs use one canonical `repository`, and Docker E2E now
validates the `git clone -> cd -> repo init -> repo start` golden path.

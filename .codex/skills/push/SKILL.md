---
name: push
description: Publish verified local commits to the remote branch without unsafe force pushes.
license: MIT
metadata:
  author: gh-symphony
  version: "1.0"
  generatedBy: "gh-symphony"
---

# /push — Git Push Workflow

## Trigger

Use this skill when publishing local commits to the remote branch.

## Flow

1. Run local tests and lint — ensure they pass before pushing
2. Push to remote:
   ```bash
   git push origin <branch>        # subsequent pushes
   git push -u origin <branch>     # first push (sets upstream)
   ```
3. If push is rejected (non-fast-forward):
   - Run `git fetch origin && git merge origin/main`
   - Resolve any conflicts
   - Re-run tests
   - Push again
4. Record push result in workpad Notes

## Rules

- Never use `--force` (destructive)
- Only use `--force-with-lease` if absolutely necessary — record the reason in workpad
- Verify CI starts after push (check GitHub Actions tab)
- Do not push directly to `main` or `master`
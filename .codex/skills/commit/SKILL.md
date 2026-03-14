---
name: commit
description: Create clean, logically scoped commits that keep the repository in a shippable state.
license: MIT
metadata:
  author: gh-symphony
  version: "1.0"
  generatedBy: "gh-symphony"
---

# /commit — Clean Commit Workflow

## Trigger

Use this skill when creating commits during implementation.

## Rules

- Commit in logical units — one concern per commit
- Never commit a broken intermediate state (tests must pass)
- Never commit temporary debug code or commented-out blocks
- Run tests before every commit

## Format

Use Conventional Commit format:

```
<type>(<scope>): <description>

[optional body — explain WHY, not WHAT, 72 chars/line]

[optional footer: Closes #N]
```

**Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

**Description**: imperative mood, 50 chars max, no period at end

## Examples

```
feat(auth): add OAuth2 token refresh
fix(api): handle null response from upstream
test(worker): add retry exhaustion coverage
```
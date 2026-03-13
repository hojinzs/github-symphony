# Decisions — init-workflow-ecosystem

## Architecture Decisions

- CLI generates minimal WORKFLOW.md — AI agent generates rich version
- context.yaml stores field IDs + option IDs for GitHub Project mutations
- Skills are static markdown templates, not executable scripts
- YAML quoting: values with `:`, `#`, `'`, `"`, `[`, `]`, `{`, `}` get double-quoted
- Skill idempotency: skip if exists (default), overwrite only with explicit flag
- context.yaml idempotency: always overwrite (latest project data)

## Wave Execution Plan

- Wave 1 (parallel): Tasks 1, 2, 3, 4, 5
- Wave 2 (parallel, after Wave 1): Tasks 6, 7
- Wave 3 (sequential, after Wave 2): Task 8
- Final Wave (parallel, after Task 8): F1, F2, F3, F4

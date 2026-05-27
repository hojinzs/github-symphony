# Skill-Local gh-symphony Resources

Date: 2026-05-27

## Status

Accepted

## Context

The repository workflow policy and orchestration configuration live in
`WORKFLOW.md`. The `/gh-symphony` skill now ships its design-time references in
the skill directory itself under `references/`.

Historically, `workflow init` and `setup` also wrote repo-local ecosystem files
for agent context and schema reference material. Those files duplicated data
that is already available from `WORKFLOW.md`, generated skill content, or live
repository detection.

## Decision

`gh-symphony setup` and `gh-symphony workflow init` no longer generate
repo-local ecosystem files. `WORKFLOW.md` remains the single repository source
of truth for workflow policy and config, while skill design resources stay
self-contained with the skill.

Existing legacy files are not read by the orchestrator. Interactive setup/init
runs detect the old files and offer to remove them. The default is to keep them.

## Consequences

- New repositories have less generated file noise.
- Skill references can evolve with the skill package instead of being copied
  into every repository.
- Existing repositories keep working if legacy files remain present.
- The deprecated `--skip-context` flag is accepted as a no-op for compatibility.

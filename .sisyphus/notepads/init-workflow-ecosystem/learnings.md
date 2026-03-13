# Learnings — init-workflow-ecosystem

## Project Structure

- pnpm monorepo, Node.js 24+, TypeScript strict mode
- packages/cli/src/ — main CLI source
  - commands/ — init.ts, tenant.ts
  - config.ts — config utilities with atomic write pattern (tmp+rename)
  - github/client.ts — GitHub API types (StatusFieldOption, ProjectStatusField, ProjectDetail)
  - mapping/smart-defaults.ts — inferStateRole(), generateStatusMap()
  - workflow/generate-workflow-md.ts — generateWorkflowMarkdown()

## Key Patterns

- Atomic write: `writeFile(path.tmp)` then `rename(tmp, path)` — see config.ts:148-153
- Path building: `join(dir, subdir)` — see config.ts:43-48
- Graceful error handling: try/catch with isFileMissing check — see config.ts:136-146
- String array build + join: see generate-workflow-md.ts:23-80

## Key Types

- `StatusFieldOption`: { id, name, description, color } — client.ts:28-33
- `ProjectStatusField`: { id, name, options[] } — client.ts:35-39
- `ProjectDetail`: { id, title, url, statusFields, textFields, linkedRepositories } — client.ts:54-61
- `StateMapping`: { role: StateRole, goal? } — config.ts:26
- `StateRole`: "active" | "wait" | "terminal" — config.ts:24

## Constraints

- PromptVariables: issue.identifier, issue.title, issue.state, issue.description, issue.url, issue.repository, issue.number, attempt — ONLY these 8
- renderPrompt() strict mode throws on unknown variables
- No yaml library — build YAML strings manually
- No new template engines
- packages/core, orchestrator, worker — DO NOT MODIFY
- Skill files: existence check before write (idempotency)
- context.yaml: always overwrite on re-run
- Runtime separation: codex → .codex/skills/, claude-code → .claude/skills/, custom → skip skills

## Test Pattern

- Vitest, node environment
- mkdtemp() for temp dirs in tests — see init.test.ts:11
- Test files: \*.test.ts alongside source files

## [Task 6] Core Skill Templates
- gh-symphony.ts: generateGhSymphonySkill() — design/refine/validate WORKFLOW.md
- gh-project.ts: generateGhProjectSkill() — GitHub Project v2 status management
- Dynamic Column ID table from ctx.statusColumns
- No {{ }} in skill output — template vars documented in backtick code
- Gotcha: "No unsupported `{{variable}}` patterns" in Validate Mode section triggered the double-brace test; replaced with prose description

## [Task 7] Workflow Skill Templates
- commit.ts: generateCommitSkill() — conventional commit format, logical units, test before commit
- push.ts: generatePushSkill() — git push workflow, no --force, verify CI starts
- pull.ts: generatePullSkill() — git fetch + merge, conflict resolution, record evidence
- land.ts: generateLandSkill() — PR merge workflow with pre-flight checks, delegates status to gh-project skill
- index.ts: barrel exports all 6 skills (gh-symphony, gh-project, commit, push, pull, land)
- ALL_SKILL_TEMPLATES array has exactly 6 entries, each with name, fileName: "SKILL.md", generate function
- All 4 test files pass (17 tests total): commit.test.ts, push.test.ts, pull.test.ts, land.test.ts
- land.ts contains 3 references to "gh-project" skill (delegation pattern)
- CLI package typecheck passes clean
- Commit: feat(cli): add workflow skill templates (commit, push, pull, land)

## [Task 8] Wire Ecosystem into Init Command
- writeEcosystem() helper: orchestrates detectEnvironment → buildContextYaml → generateReferenceWorkflow → writeAllSkills
- writeContextYaml(outputDir, ctx) expects repo root as outputDir — it appends .gh-symphony/context.yaml internally
- `as const` on test fixtures causes readonly array incompatibility with mutable ProjectDetail types — use explicit type annotations instead
- WriteConfigInput.statusField widened to include { id, name, options[].id, options[].color } for field ID plumbing
- tenant.ts interactive call site needed id: statusField.id added
- Existing tests needed textFields: [] added to ProjectDetail fixtures
- runInteractiveFromTenant: re-fetches project from GitHub using globalConfig.token for ecosystem generation (best-effort, try/catch)
- runInteractiveStandalone: already has full projectDetail and statusField available
- --skip-skills and --skip-context flags only apply to non-interactive mode
- 4 new tests + 3 existing tests = 7 total in init.test.ts, all pass

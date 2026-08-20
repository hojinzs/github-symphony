# Standalone Project Model — Issue Breakdown Plan

> **Source spec:** `docs/designs/2026-08-11-standalone-project-model-design.md` (commit `d994c6e`)
> **Repository:** `hojinzs/github-symphony`
> **Status:** Active — executed by dogfooding gh-symphony (Project #14, initial state Backlog, promotion to Ready is done by a human)
> **Composition:** 1 epic + 9 implementation issues. Each issue body can be used directly with `gh issue create --body-file -`.

The design document is the single source of truth. Each issue embeds its relevant slice so workers do not have to read the entire document.

## Dependency graph

```
┌─ #1 D2 core: ProjectConfig extension ──────────── (foundation — everything depends on this)
│
├──┬─ #2 D3: workflow source resolution + shadow warning
│  └─ #3 D4a: bare clone cache module (lock + TTL fetch)     ← can run in parallel with #2
│         │
│         └─ #4 D4b+D8: worktree populate + branch template + cleanup lifecycle
│                │
│                └─ #6 D5: layered skill merge injection + git exclude
│
├─ #5 D9: project .env relocation + $VAR source expansion      ← can run in parallel with #2–4
├─ #7 D6: MCP layering (.mcp.json sidecar)          ← can run in parallel after #1
│
└─ #8 CLI: project add / project-folder startup + disjointness validation   ← after #2
      │
      └─ #9 closure: Docker E2E + docs + changeset + ADR    ← after everything
```

## Verification gates

Every issue's PR must pass:

```bash
pnpm lint && pnpm test && pnpm typecheck && pnpm build
```

CLAUDE.md convention: after completing work, test cases must be written and executed for verification. Integration behavior that unit tests cannot cover is verified with black-box tests in the Docker E2E environment (AGENT_TEST.md) — E2E integration verification is owned by #9, but each issue also includes unit/integration TCs for its own scope.

---

## Epic — Standalone project model implementation

**Title:** `epic: standalone project model (repo-decoupled projects)`
**Labels:** `epic`
**Initial state:** Backlog (tracking only — do not promote to Ready)

```markdown
## Overview

Implement the standalone project model, which decouples the storage location of
orchestration policy (WORKFLOW.md, skills, MCP, env) from the source repository.
Design: `docs/designs/2026-08-11-standalone-project-model-design.md` (D1–D9).

In one sentence: the project folder (WORKFLOW.md + .mcp.json + .env + .agent/skills) becomes
the execution unit, and the repository does not know Symphony is running (repo-unaware).
1 repo : N projects.

## Sub-issues

- [ ] #1 feat(core): extend OrchestratorProjectConfig
- [ ] #2 feat(orchestrator): workflow source resolution
- [ ] #3 feat(orchestrator): bare clone cache
- [ ] #4 feat(orchestrator): worktree populate + branch namespace
- [ ] #5 feat(orchestrator): project .env relocation
- [ ] #6 feat(worker): layered skill injection
- [ ] #7 feat(core,runtime): MCP layer composition
- [ ] #8 feat(cli): standalone project registration and startup
- [ ] #9 test(e2e): E2E + docs + changeset + ADR

(Update with actual issue numbers after publishing)

## Order

#1 → {#2, #3, #5, #7 in parallel} → #4 → #6, #2 → #8 → #9

## Definition of done

- Docker E2E: black-box pass from project folder creation → registration → run-once → worktree populate → skill/MCP injection → worker execution
- No regression in the existing repo-embedded mode
- Follow-up "1 project = 1 instance" ADR merged
```

---

## Issue #1 — feat(core): extend OrchestratorProjectConfig for standalone projects

**Labels:** `core`, `enhancement`
**Depends on:** none (foundation)
**Effort:** S

```markdown
Part of epic #<EPIC>. Design: docs/designs/2026-08-11-standalone-project-model-design.md — D2.

## Background (design slice)

Make a "project" a first-class execution unit independent of the repository. Instead of
inventing a new concept, extend the existing
`OrchestratorProjectConfig` (packages/core/src/contracts/status-surface.ts).
The project folder is the source of truth; the orchestrator's config.json is registration/derived state.

## Scope of work

- [ ] Add fields to `OrchestratorProjectConfig`:
  - `workflowSource: { type: "repo" } | { type: "external"; path: string }` (default: existing behavior = repo)
  - `populateStrategy?: "clone" | "worktree-cache"` (default: "clone" = existing behavior)
  - `projectDir?: string` (path to the standalone project folder)
- [ ] fs-store (`packages/orchestrator/src/fs-store.ts`) persistence round-trip + backward compatibility (existing config.json without the fields = repo/clone defaults)
- [ ] Align the CLI `CliProjectConfig` derived type (packages/cli/src/config.ts)
- [ ] Validation: external with missing/non-absolute path → explicit error

## Acceptance Criteria

- Loading an existing config.json (without the new fields) causes no behavior change (backward-compat TC)
- Save→load round-trip TC for the new fields
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #2 — feat(orchestrator): mode-declared workflow source resolution with shadow warning

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #1
**Effort:** M

```markdown
Part of epic #<EPIC>. Design: D3 (+ D1).

## Background (design slice)

The workflow source is a mode declaration, not a priority contest: when
`workflowSource.type === "external"`, only the project folder's WORKFLOW.md is read and the
repository interior is never consulted. When "repo", the existing behavior (lookup within the
checkout) applies. Loading an external file is conforming — it is priority 1 of upstream spec
§5.1 ("explicit runtime setting").
Security rationale: hooks.\* execute a shell on the host, so someone with repo commit access
must not be able to obtain a shell on the operator's machine.

## Scope of work

- [ ] Add a `workflowSource` branch to the workflow resolution path (the orchestrator's WorkflowResolution loading)
- [ ] External mode: load `<projectDir>/WORKFLOW.md`; if absent, `missing_workflow_file` error (preserve the spec §5.1 loader contract)
- [ ] Dynamic reload in external mode: watch target becomes the external file (spec §6.2)
- [ ] **Shadow warning**: in external mode, if WORKFLOW.md also exists in the repo checkout, surface a warning on the status surface (Observability)
- [ ] Parse the `repository` front matter extension key (D1 — spec §5.3 extension rules; keep unknown-key-ignore compatibility)

## Acceptance Criteria

- TC proving the in-repo WORKFLOW.md is never read in external mode
- Shadow-situation warning TC / no-regression TC for repo mode
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #3 — feat(orchestrator): global bare clone cache with locked TTL fetch

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #1
**Effort:** M

```markdown
Part of epic #<EPIC>. Design: D4 + the "Clone cache operational details" section.

## Background (design slice)

Repo clones are kept exactly once in a global cache `~/.gh-symphony/repos/<owner>/<repo>.git` (bare).
Projects sharing the same repo are separate processes (D7), so file locks are the only coordination
mechanism. Reuse the mkdir lock pattern and constants from the existing
`packages/orchestrator/src/git.ts` (retry 100ms, stale 30 minutes, timeout 2 minutes).

## Scope of work

- [ ] Bare cache module: initial `clone --bare`, serialized under a lock (`<repo>.lock` mkdir style)
- [ ] TTL fetch: skip if the last fetch was within 60 seconds (timestamp marker inside the bare repo, evaluated under the lock). If a required ref is missing, ignore the TTL and fetch
- [ ] `git gc --auto` after fetch
- [ ] Auth: keep the existing credential path (gh auth / credential helper) as-is; never write tokens into the cache or workspaces
- [ ] The cache home is based on `DEFAULT_CONFIG_DIR` (`~/.gh-symphony`), honoring the `GH_SYMPHONY_CONFIG_DIR` override

## Acceptance Criteria

- Concurrent fetch serialization TC (two calls execute sequentially via the lock)
- TTL skip / forced fetch on missing ref TC
- Stale lock reclamation TC (identical to the existing git.ts lock semantics)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #4 — feat(orchestrator): worktree populate from clone cache with project-scoped branches

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #3 (+#1)
**Effort:** L

```markdown
Part of epic #<EPIC>. Design: D4, D8 + the "Clone cache operational details" section.

## Background (design slice)

Populate the issue workspace as a worktree from the bare cache instead of a full clone
(`syncRepositoryForRun`). Only when `populateStrategy === "worktree-cache"` — the "clone"
(existing) path stays intact (rollout separation).
git refuses double checkouts of the same branch, so branch uniqueness is enforced at the git
level → the branch template `symphony/<project-slug>/<sanitized-issue-id>` is mandatory
(front matter override allowed).

## Scope of work

- [ ] Populate: ensure bare (#3) → TTL fetch → `git worktree add -b <branch> <workspace-path> origin/<base>` (under the lock)
- [ ] Branch template default + front matter override key
- [ ] Failure semantics (spec §9.3): attempt error; a new workspace may have partial artifacts removed; a reused workspace must not be destructively reset
- [ ] Cleanup: at the startup terminal cleanup point (spec §8.6), chain `before_remove` hook → `git worktree remove` → `git worktree prune` under the lock
- [ ] Orphan GC: one `git worktree prune` under the lock at populate time
- [ ] Strategy switch: select the existing clone path / new worktree path based on `populateStrategy`

## Acceptance Criteria

- Worktree populate success/reuse/failure semantics TC
- TC proving no branch collision when two projects on the same repo populate the same issue number (slug namespace)
- Worktree removal + prune on terminal cleanup TC
- No-regression TC for `populateStrategy: "clone"`
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #5 — feat(orchestrator): project .env relocation and $VAR resolution source

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #1
**Effort:** S

```markdown
Part of epic #<EPIC>. Design: D9.

## Background (design slice)

Project env is declared in `<projectDir>/.env` (dotenv, 0600). No front matter `env` key is introduced.
`readProjectEnv` (packages/orchestrator/src/service.ts) already merges the project directory's `.env`
into the worker env, so for standalone projects the work is repointing the read location to the
project folder.
Priority stays as-is: explicit env > host process env > project .env.

## Scope of work

- [ ] For standalone projects (`projectDir` present), read `.env` from the project folder
- [ ] Expand the `$VAR` resolution source: `$VAR` in front matter (§6.1) and MCP composition resolves from "host process env + project .env"
- [ ] `.env` file permission check: warn if not 0600 (do not refuse to read — operational convenience)
- [ ] Keep the no-automatic-passthrough-to-agent rule: no change to the `SAFE_RUNTIME_ENV_KEYS` allowlist (runtime-codex)

## Acceptance Criteria

- Standalone `.env` loading and priority TC (spread order unchanged)
- TC where `$VAR` resolution picks up the project .env value + TC where host env wins
- TC proving project .env keys do not leak into the agent env
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #6 — feat(worker): layered skill injection into worktrees

**Labels:** `worker`, `enhancement`
**Depends on:** #4
**Effort:** M

```markdown
Part of epic #<EPIC>. Design: D5.

## Background (design slice)

Skills are not committed to the repo; they are injected into the worker execution environment:
the global (`~/.gh-symphony/skills`) → project (`<projectDir>/.agent/skills`) layers are merged
(project wins on name conflict) and **copied** into the worktree's runtime-native path
(`.claude/skills` / `.codex/skills`) **before every attempt (at the before_run point)**.
Links are forbidden (isolation, sandboxing, and snapshot-observability reasons).
git concealment: register the skill paths in each worktree's `.git/info/exclude` (preserving repo-unaware).

## Scope of work

- [ ] Layer-merge copy module (global→project, nearest wins, full re-copy before every attempt)
- [ ] Register skill paths in `.git/info/exclude` at populate time (#4)
- [ ] Move the rendering point of generated skills (packages/cli/src/skills/templates) to project creation/modification time — rendered output is stored in the project skill layer; injection logic only "merges and copies"
- [ ] Verify the codex runtime skill discovery path (whether it is cwd-based — design Open Question 3), then finalize placement

## Acceptance Criteria

- Merge rule TCs (project wins on conflict, global only, project only)
- TC where a skill modified between attempts is reflected on retry (re-copy)
- TC where injected skills do not appear in `git status` (exclude)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #7 — feat(core,runtime): layered MCP composition with project .mcp.json sidecar

**Labels:** `core`, `runtime`, `enhancement`
**Depends on:** #1
**Effort:** M~L

```markdown
Part of epic #<EPIC>. Design: D6.

## Background (design slice)

Layer the MCP server declarations: Symphony built-ins (reserved names `github_graphql`/`linear_graphql`, always win) >
project `<projectDir>/.mcp.json` > global `~/.gh-symphony/mcp.json` > repo `.mcp.json`
(in standalone mode the repo layer is off by default, opt-in via `trust_repo_config` — MCP entries
are host-executed commands, so the same security logic as D3 applies). The declaration shape is the
standard `mcpServers`. Secrets: literals forbidden, `$VAR` only.
Composition follows the existing `mcp-compose.ts` pattern: every attempt, in the runtime directory outside the worktree, 0600.

## Scope of work

- [ ] Runtime-neutral MCP layer merge logic in core (including reserved-name protection)
- [ ] claude adapter: inject the project/global layers into `composeClaudeMcpConfig` (packages/runtime-claude/src/mcp-compose.ts), with an opt-in gate for the repo layer
- [ ] codex adapter: translate the merge result into `RuntimeToolDefinition` registration (packages/runtime-codex/src/runtime.ts)
- [ ] Literal token validation: refuse to load `.mcp.json` if an env value is not in `$VAR` form + explicit error
- [ ] `$VAR` resolution source consistent with #5 (host env + project .env)

## Acceptance Criteria

- Layer priority TC (a project cannot shadow built-in reserved names)
- Repo layer default-off / opt-in on TC
- Literal token rejection TC
- Composed file 0600 + outside-worktree location TC (existing semantics preserved)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #8 — feat(cli): standalone project registration and startup

**Labels:** `cli`, `enhancement`
**Depends on:** #2
**Effort:** M

```markdown
Part of epic #<EPIC>. Design: D2, D7 (registration validation part), and the target directory structure.

## Background (design slice)

Register and start standalone projects via the CLI. Supervisor details are a separate spec, but
project-folder-based registration and single-project startup belong to the CLI. At registration
time, perform tracker-mapping disjointness validation (warning) against existing projects sharing
the same repo+tracker — if they overlap, two orchestrators will pick up the same issue.

## Scope of work

- [ ] `gh-symphony project add <projectDir>`: parse WORKFLOW.md front matter → create and register `OrchestratorProjectConfig` (external source) (`~/.gh-symphony/projects/<id>/project.json`)
- [ ] Registration validation: front matter parsing + dispatch preflight (spec §6.3) + tracker-mapping overlap check against already-registered projects (overlap = warning + confirmation required)
- [ ] Startup: the existing start path runs `workflowSource: external` projects based on the project folder (removing the cwd-is-repo assumption)
- [ ] Show standalone projects in `project list`/`status` (including shadow warnings, wired to #2)

## Acceptance Criteria

- add→list→start→stop round-trip TC
- Tracker-mapping overlap warning TC
- No-regression TC for the existing repo-embedded flow (`repo init`/`repo start`)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

---

## Issue #9 — test(e2e): standalone project model end-to-end + docs + changeset + ADR

**Labels:** `test`, `documentation`
**Depends on:** all of #1–#8
**Effort:** M

```markdown
Part of epic #<EPIC>. Design: entire document (closure).

## Scope of work

- [ ] Docker E2E (AGENT_TEST.md conventions): create project folder (WORKFLOW.md/.mcp.json/.env/.agent/skills) →
      `project add` → `run-once` → bare cache creation → worktree populate (verify branch namespace) →
      verify skill/MCP injection (including clean git status) → black-box verification through worker execution
- [ ] Scenario with 2 projects running concurrently on the same repo (disjoint mappings, branch isolation)
- [ ] Update `docs/configuration.md`: standalone mode, project folder conventions, populate strategy, branch template, .env
- [ ] Write a changeset (`@gh-symphony/*` minor)
- [ ] Follow-up ADR: a decision record refining `2026-05-04_single-repo-orchestrator.md` ("1 repo = 1 instance") to "1 project = 1 instance"
- [ ] Update the design document Status: Draft → Shipped

## Acceptance Criteria

- E2E black-box pass (both new standalone and existing repo-embedded)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` passes
```

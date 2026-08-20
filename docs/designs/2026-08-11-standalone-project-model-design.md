# Spec: Standalone Project Model — Repo-Decoupled Execution Units and Supervisor Topology

- **Date**: 2026-08-11
- **Status**: Shipped
- **Symphony Layers**: Policy (WORKFLOW.md externalization), Configuration (project manifest, MCP, skill layers), Coordination (supervisor topology, registration validation), Execution (worktree populate, skill/MCP injection), Observability (status aggregation, shadow warnings)
- **Related ADRs**:
  - `docs/adr/2026-05-04_single-repo-orchestrator.md` — adopted "1 repo = 1 instance". This design **refines it to "1 project = 1 instance"** (allowing 1 repo : N projects). Once finalized, record the relationship in a follow-up ADR.

## Context / Problem

The current approach is a repo-embedded model that commits WORKFLOW.md and skills inside the repository. There are five problems:

| #   | Problem                                                                                  |
| --- | ---------------------------------------------------------------------------------------- |
| P1  | The agent workflow is forced on anyone who receives the repo                             |
| P2  | Multiple projects (feature tracks) cannot be orchestrated concurrently on one repo       |
| P3  | Modifications in the local checkout affect execution                                     |
| P4  | Customizing issue-start scaffolding (worktree location, env, start scripts) is difficult |
| P5  | Setting up WORKFLOW.md/skills requires repo commits, making onboarding cumbersome        |

Common cause: **the storage location of orchestration policy (the Policy layer) is coupled to the source repository.**

## Goals

1. **Dual mode** — keep the existing repo-embedded mode + add a **standalone mode** based on a project folder outside the repo
2. **Repo-unaware principle** — in standalone mode the repository does not know Symphony is running (no commit traces or required files)
3. **Control Plane readiness** — the project folder structure becomes the data model of the future Control Plane

Future Control Plane requirements (referenced only as design constraints): repo connection and project creation (CP1), agent-driven WORKFLOW.md generation (CP2), tracker issue-publishing agent (CP3), execution log viewing (CP4).

## Decisions

### D1. Project manifest = WORKFLOW.md front matter (no separate manifest)

The upstream spec already defines it: the front matter (`tracker`/`polling`/`workspace`/`hooks`/`agent`/`codex`) is the manifest, and the §5.2 design note requires "self-contained with no out-of-band configuration". No separate `project.yaml` is introduced.

- The repo reference is added as a **`repository` extension key** per the §5.3 extension rules.
- An external WORKFLOW.md is not a divergence — it is exactly §5.1 path priority 1 ("explicit runtime setting"). Only the single point of friction, the "repository-owned and version-controlled" soft expectation, is documented.
- The proposed `.runners/` structure is also not a new mechanism — it is implemented by specifying `workspace.root` in per-project front matter (the per-issue path rule `<root>/<sanitized_issue_id>` follows §9.1 as-is).

### D2. Project = first-class execution unit, extending the existing `OrchestratorProjectConfig`

A "project" is an **orchestration execution unit** bundling WORKFLOW.md policy + tracker mapping + skill/MCP layers + a worktree pool. The repository is merely a resource the project references (1 repo : N projects).

- Instead of inventing a new concept, extend the existing `OrchestratorProjectConfig` (`packages/core/src/contracts/status-surface.ts`). It already has `projectId`/`slug`/`workspaceDir`/`repository`/`tracker`, and the state store and status surface sit on top of it, minimizing migration.
- Additional fields: `workflowSource: { type: "repo" } | { type: "external"; path }`, etc.
- **The project folder is the source of truth; `config.json` is registration/derived state.**
- The `workspaces/` state directory naming collides with the spec's Workspace (§4.1.4, per-issue directory) — separate cleanup item.

### D3. The workflow source is a mode declaration, not a priority contest

The project declares its `workflow source`: a standalone project reads only the external file and never consults the repository interior. Repo-embedded is the opposite. No dynamic "search both and pick a winner" rule exists.

- Rationale 1 — security: `hooks.*` execute a shell on the host. If a rule let the repo interior win, anyone with repo commit access could execute an arbitrary shell on the operator's machine. Control over execution policy stays with the operator.
- Rationale 2 — the same structure as §5.1's "explicit runtime setting > cwd default".
- The shadow situation (standalone mode while WORKFLOW.md also exists in the repo) is surfaced as a warning on the status surface.

### D4. Global bare clone cache + built-in worktree populate

- Repo clones live exactly once as bare clones in the global cache (`~/.gh-symphony/repos/<owner>/<repo>.git`). Consistent with the 1 repo : N projects structure. No new Symphony home is created — the existing CLI config directory `~/.gh-symphony` (`DEFAULT_CONFIG_DIR`) is used as-is.
- Issue workspace populate (creating a worktree from the clone cache) is implemented as a **built-in feature** (based on the `repository` extension key), not as an `after_create` hook convention. Conforming, since spec §9.3 marks populate as implementation-defined.
- Isolated worktree execution solves P3 (local modifications affecting execution).
- Operational details (locking, fetch policy, lifecycle) are in the "Clone cache operational details" section below.

### D8. Branch namespace — including the project slug is mandatory

The default branch template is **`symphony/<project-slug>/<sanitized-issue-id>`**, with template override allowed via front matter.

This is not a style choice but a structural consequence of D4: git refuses to let two worktrees check out the same branch simultaneously, so the moment projects share a bare clone, branch uniqueness across all projects and issues on the same repo is required at the git level. Also serving remote-push conflict prevention, the project slug is included in the branch name to guarantee uniqueness structurally.

### D5. Skill injection — render at project creation, merge-copy on every attempt, conceal from git

> Render at project creation → before every attempt (at the before_run point), merge-copy the global+project layers → place into the worktree's runtime-native path (`.claude/skills` / `.codex/skills`) → conceal from git via each worktree's `.git/info/exclude`.

- **Copy, no links**: symbolic links would let a worker tamper with the shared skill directory and propagate it to all projects (the cross-issue contamination incident class), escape the sandbox boundary (codex `turn_sandbox_policy`), and make skill snapshots at execution time unobservable. Copy cost is KB-scale and negligible.
- **Re-copy on every attempt**: because of workspace reuse in spec §9.1, a one-shot `after_create` injection means skill modifications are not reflected in subsequent runs. Re-copying absorbs the only advantage of links (freshness).
- **`.git/info/exclude` registration**: if skills show up in `git status` and the agent commits them, repo-unaware breaks. Being a per-worktree setting, it leaves no trace in the repo, and since populate is built-in (D4), the registration point is natural.
- **Layer merge**: global (`~/.gh-symphony/skills`) → project (`<project>/.agent/skills`), project wins on name conflict (nearest wins).
- **Generated skills** (commit/push/land/gh-project etc. templates, `packages/cli/src/skills/`): rendered into the project skill layer at **project creation/modification time**, not at injection time (the same stage as CP2). Injection logic stays simple: "merge and copy".

### D6. MCP — `.mcp.json` sidecar in the project folder

The upstream spec has no MCP at all (zero occurrences). Tools are defined only via the §10.5 adapter approach, so MCP support is entirely our extension area and has no reason to be constrained by front matter extension keys.

- **Declaration**: `.mcp.json` at the project folder root (standard `mcpServers` shape). Rationale: (1) in standalone mode the self-contained unit is the project folder, not a file, and `.agent/skills/` already sets the precedent. (2) It is the de facto standard format — copying an existing repo's `.mcp.json` into the folder just works (free migration), and schema validators / editor support are reused, simplifying the Control Plane editing UI. (3) Avoids the awkwardness of nesting JSON inside YAML front matter. (4) Separation of roles: WORKFLOW.md = policy + orchestration config, `.mcp.json` = agent tool config.
- **Layer priority**: Symphony built-ins (reserved names `github_graphql`/`linear_graphql`, always win) > project `.mcp.json` > global `~/.gh-symphony/mcp.json` > repo `.mcp.json`. If built-in tools get shadowed, workflow transitions break, so they are protected via reserved names.
- **The repo layer is off by default in standalone mode, explicit opt-in** (`trust_repo_config`-style). MCP entries are commands executed on the host, so the same security logic as D3 applies.
- **Secrets**: literal tokens forbidden; only §6.1 `$VAR` indirection is allowed (enforced by validation). Tracker tokens keep going through the existing broker — the upstream §10.5 principle "MUST NOT require the coding-agent child process to read raw tracker tokens".
- **Composition**: reuse the existing `mcp-compose.ts` pattern — every attempt, composed at 0600 into the runtime directory outside the worktree. Per-attempt composition means no sidecar watch is needed (dynamic reload only applies to front matter for the orchestrator loop).
- **Runtime asymmetry**: declaration happens once in core in a runtime-neutral shape; translation is the adapter's responsibility — claude uses a composed `.mcp.json` + `--mcp-config` argv, codex uses `RuntimeToolDefinition` registration (`packages/runtime-codex/src/runtime.ts`).

### D7. Topology — orchestrator unchanged, supervisor placed above

**The orchestrator stays as-is: one process = one project** (keeping the current structure where the `OrchestratorService` constructor takes a single `projectConfig`). Multi-project is handled by a **supervisor** above it.

- Rationale: spec §2.2 Non-Goals explicitly lists "Rich web UI or multi-tenant control plane" — putting multi-tenancy inside the orchestrator contradicts the spec's scope declaration. The entire spec treats the orchestrator as a single-workflow standalone service and the single state authority (§7, §8.1, Appendix A), and multi-instance topology is deliberately left to implementers. Therefore the supervisor is not a divergence but an **extension layer outside the spec**.
- Supervisor responsibilities: project folder registration and discovery, spawning/restarting/health-checking one orchestrator process per project, assigning child status-server ports (or unix sockets), aggregating status APIs and exposing a single endpoint (:4680). **The Control Plane talks only to the supervisor.**
- **Registration-time disjointness validation**: the supervisor validates at project registration that the tracker mappings (project_slug, labels, status boards) of projects sharing the same repo+tracker do not overlap. Since orchestrators do not know about each other, registration-time validation — not runtime coordination — is the right place.
- Rate limiting: polling is independent per instance, but the existing self-throttling (widening polling intervals when a low rate limit is detected) prevents runaway. If cross-coordination becomes necessary, add it to the supervisor later.

### D9. Project env is a `<project>/.env` file — no front matter `env` key

Project env is declared in the project folder's `.env` (dotenv format, 0600 enforced). No front matter `env` key is introduced.

- **Rationale**: env values are mostly secrets. WORKFLOW.md is committed to the repo in repo-embedded mode and read by the Control Plane, so by the same logic as D6 ("no literal tokens in declaration files"), the place for secrets is `.env`, not a declaration file. The mechanism also already exists — `readProjectEnv` (`packages/orchestrator/src/service.ts`) already merges the project directory's `.env` into the worker env; the work is only repointing the read location to the project folder.
- **The three roles of `.env`**: (1) hook execution env — P4's start scripts are hooks and their variables go in `.env`, completing P4. (2) worker process env — unchanged. (3) the **`$VAR` resolution source** for front matter and `.mcp.json` — the resolution source is "host process env + project `.env`". Spec §6.1 does not pin down the origin of env indirection, so this is clarification-level.
- **No automatic passthrough to the agent**: project env reaches only hooks, the worker, and `$VAR` resolution. The agent subprocess keeps the existing `SAFE_RUNTIME_ENV_KEYS` allowlist (runtime-codex, see PR #509 history). Cases needing variables inside the agent are handled by hooks; an explicit passthrough list is added when needed (YAGNI).
- **Priority unchanged**: explicit env > host process env > project `.env` (the `buildProjectExecutionEnv` spread order as-is). Host env overriding project settings keeps the operator in control, consistent with D3's "operator first" principle.

## Clone Cache Operational Details (D4, D8)

The current implementation does a full clone per issue workspace (`packages/orchestrator/src/git.ts` `syncRepositoryForRun` — clone into `<workspace>/repository`, re-clone on failure). This design replaces it with a shared bare cache + worktrees.

### Layout and locking

```
~/.gh-symphony/repos/<owner>/<repo>.git    # bare clone (shared by all projects)
~/.gh-symphony/repos/<owner>/<repo>.lock   # mkdir-based lock directory
```

- By the topology (D7), projects sharing the same repo are **separate processes**, so file locks are the only cache coordination mechanism.
- Reuse the mkdir lock pattern and constants from the existing `git.ts` (retry 100ms, stale 30 minutes, timeout 2 minutes).
- Operations serialized under the lock: initial bare creation (`clone --bare`), fetch, `worktree add`/`remove`/`prune`.

### Fetch freshness policy

- **Fetch immediately before populate (worktree creation)** — base ref freshness is populate's responsibility.
- **TTL skip**: skip if the last fetch was within the TTL. Evaluated under the lock via a timestamp marker inside the bare repo. **Default 60 seconds.** Prevents fetch bursts when multiple issues on the same repo are dispatched in one tick. However, **if a required ref is missing, ignore the TTL and fetch**.
- **Retry attempts do not re-fetch**: worktrees are reused per issue (spec §9.1), and freshening (rebase, etc.) is the responsibility of the agent/workflow policy.

### Worktree lifecycle

- **Create**: ensure bare → TTL fetch → `git worktree add -b symphony/<project-slug>/<issue-id> <workspace-path> origin/<base>` (branch template per D8).
- **Failure semantics**: spec §9.3 as-is — a populate failure is an error for that attempt. For a new workspace, partial artifacts may be removed; a reused workspace must not be destructively reset.
- **Cleanup**: connected at the spec §8.6 (startup terminal workspace cleanup) point — `before_remove` hook → `git worktree remove` → `git worktree prune` under the lock.
- **Orphan GC**: one `git worktree prune` under the lock at every populate (cleans up residual admin data of manually deleted workspaces; negligible cost). No separate GC process.
- **Disk**: start with `git gc --auto` after fetch. A sophisticated size policy can follow if needed.

### Auth

Unchanged: bare fetches are performed by the orchestrator host process via the existing credential path (gh auth / credential helper). Tokens are never written into worktrees.

### Applicability (rollout)

The populate strategy is a project property: `worktree-cache` (new) vs `clone` (existing full clone). **Standalone projects default to `worktree-cache`; repo-embedded keeps the existing behavior for now**, converging later. The two modes are not changed at the same time.

## Target Directory Structure

```
~/.gh-symphony/                     # Symphony home = existing CLI config directory (DEFAULT_CONFIG_DIR)
  repos/<owner>/<repo>.git          # D4: global bare clone cache (+ <repo>.lock)
  skills/                           # D5: global skill layer
  mcp.json                          # D6: global MCP layer

projects/
  project-a/
    WORKFLOW.md                     # D1: policy + front matter manifest (repository extension key, workspace.root)
    .mcp.json                       # D6: project MCP ($VAR only)
    .agent/skills/                  # D5: project skill layer (rendering location for generated skills)
    .env                            # D9: project env (dotenv, 0600) — source for hooks, worker, and $VAR resolution
  project-b-1/                      # second project on the same repo (solves P2)
    WORKFLOW.md
    ...

<workspace.root>/                   # specified by per-project front matter (.runners etc., free choice)
  <sanitized-issue-id>/             # per-issue workspace = worktree carved from the clone cache
                                    # skills/MCP injected on every attempt, concealed via .git/info/exclude
```

## Open Questions (follow-up decisions)

1. **Supervisor detailed design** — **split into a separate design document** (out of scope for this spec). Process lifecycle, status aggregation API shape, registration protocol. Note: proto-supervisor infrastructure already exists in the CLI — the `~/.gh-symphony/projects/<id>/project.json` registry, per-project daemon PID/log/liveness determination (`packages/cli/src/daemon-liveness.ts`), and the `@gh-symphony/control-plane` and `@gh-symphony/dashboard` packages. The separate design should start on top of these.
2. **`workspaces/` state directory naming cleanup** — terminology collision with the spec's Workspace (D2)
3. **Verify the codex runtime skill discovery path** — confirm whether it is cwd-based, then finalize D5 placement (verify in `runtime-codex`)
4. **Control Plane secret store** — how to manage the origins of `$VAR` per project (during Control Plane design). D9's `.env` is the store for now, and the Control Plane can treat it as something to manage rather than replace
5. **repo-embedded → standalone migration path** — procedure for wrapping existing setups into the project model (including `clone` → `worktree-cache` populate strategy convergence)
6. **Follow-up ADR** — a decision record refining the relationship with `2026-05-04_single-repo-orchestrator.md` ("1 repo = 1 instance") to "1 project = 1 instance"

Resolved items (2026-08-11): clone cache operations and branch namespace → D4, D8 and the "Clone cache operational details" section. Project env declaration → D9.

## Spec Conformance Summary

| Item                          | Classification                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- |
| External WORKFLOW.md          | **Conforming** — §5.1 priority 1. Only the soft expectation is documented        |
| `repository` extension key    | **Conforming** — §5.3 extension rules                                            |
| .runners via `workspace.root` | **Conforming** — §5.3.3, §9.1                                                    |
| Built-in worktree populate    | **Conforming** — §9.3 implementation-defined                                     |
| Skill/MCP injection           | **Extension outside the spec** — the spec has no skill/MCP concepts              |
| Supervisor                    | **Extension layer outside the spec** — §2.2 Non-Goals points to placing it above |
| Branch namespace (D8)         | **Outside the spec** — the spec does not prescribe VCS workflows (§9.3)          |
| Orchestrator changes          | **None** — single-project process preserved                                      |

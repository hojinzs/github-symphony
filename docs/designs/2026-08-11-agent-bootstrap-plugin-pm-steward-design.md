# Spec: Agent Bootstrap Plugin and PM Steward

- **Date**: 2026-08-11
- **Status**: Draft
- **Symphony Layers**: Policy (WORKFLOW.md generation), Configuration (project folder artifacts), Coordination (project registration, PM supervision), Observability (reporting, status monitoring)
- **Related**:
  - `docs/designs/2026-08-11-standalone-project-model-design.md` — the premise of this spec. Decisions D1–D9 are taken as the base conventions.
  - Supervisor detailed design (separate spec, not yet written) — the status-query target of the PM steward.

## Context / Problem

The only path to getting started with Symphony today is "a human learns the CLI and sets things up directly in the repo". There are three goals:

1. **Agent-driven start** — a Claude/Codex agent performs everything itself, from discovery through setup and startup
2. **Plugin distribution** — package this capability as a plugin (skill set) distributable to repositories, with the standalone/multi-orchestrator conventions (D1–D9) as the defaults
3. **PM steward** — an operational loop in which a PM agent supervises and reports on the projects handled by Symphony

### Findings from the history investigation

**(a) The four Symphony skills** — exist locally only in `~/.claude/skills/` (written 2026-05-27, v0.1.0, not under git, not included in the repo):

| Skill                               | Role                   | Key patterns                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-symphony-bootstrap`         | Zero-base setup        | read-only discovery → proposal → **apply only the approved scope** (5-stage modes: plan/apply-local/apply-remote/seed-backlog/activate) → readback verification                                                                           |
| `github-symphony-workflow-author`   | Policy file generation | discovery + lifecycle decisions → WORKFLOW.md + `.gh-symphony/*.yaml`. Existing human policy is patched, never overwritten                                                                                                                |
| `github-symphony-project-lifecycle` | State model design     | 7-state default lifecycle (Backlog/Ready/In progress/In review/Land/Done/Blocked), active/wait/terminal mapping, the "In review waits for a human, Land is the autonomous landing queue" principle, option ids obtained only via readback |
| `github-symphony-project-steward`   | PM agent install & ops | Permission levels 0–4 (Observer→Autonomous PM), `pm.yaml` policy file, self-contained cron prompts, decision queue, allowed/forbidden transition table                                                                                    |

The four are one set connected via related_skills, and the safety design (approval gates, readback verification, permission levels) is mature. However, **all of them assume the repo-embedded-era conventions** — see "Update points" below.

**(b) The `~/Projects/maintenance` PM loop** — a PM workspace in live operation (`/loop 30m` + LOOP.md). Holds operational rules distilled from real incidents:

- **Single input collection**: one `scripts/collect-inbox.sh` collects quotas, locks, boards, comments, and reviews in one pass. "When rules are scattered, one will inevitably be missed" (the 2026-08-11 incident where 8 Ready items / 2 approvals / changes-requested were each missed for different reasons)
- **Duplicate-loop lock**: `state/loop-lock.json` (the 2026-08-11 incident of two sessions running duplicated for 18 hours)
- **No speculative reporting**: external state is measured at reporting time; if it could not be measured, report "unverified" (the multi-cycle misreporting incident while waiting for a CMS redeploy)
- **Record human decisions immediately**: `docs/decisions/`
- **Gates**: assignment gate (bot account assignees only), double approval gate (Land state + human approve, Backlog→Ready moved by a human), no destruction + a one-time permission probe before starting
- **Role separation**: judgment, verification, and reporting are the PM's (Claude); implementation is delegated (`codex exec --cd <worktree> --full-auto`)
- **Structure**: git-managed workspace, `docs/projects/` (per contract) and `docs/repository/` (per-repo notes), `state/` (committed), one Slack thread per cycle

Of note: maintenance's `.projects/<repo>/base` (fetch-only base clone) + `issue-N` worktree structure is **the same pattern that standalone design D4 converged on independently**. It amounts to operational validation of D4.

## Scope — 3-Layer Structure

```
[3] PM steward       supervises and reports on projects (generalization of the maintenance loop)
[2] Skill convention update   rewrite the 4 skills against the D1–D9 conventions
[1] Plugin packaging  turn the skills into a repo-distributable plugin
```

Document hierarchy: standalone project model (premise) → supervisor spec (separate) → **this spec** (the agent-experience layer on top).

## Proposed Decisions

### B1. Move the skill source into the monorepo, package as a plugin

- Move the source of truth of the 4 skills from `~/.claude/skills/` (local) **into this monorepo** (e.g. `plugins/gh-symphony/skills/`). They become subject to version control, review, and testing.
- Distribution form: a Claude Code **plugin** (marketplace format, skills bundled). For Codex, reuse the existing CLI-rendered distribution approach (the per-runtime paths in `skill-writer.ts`).
- **Distinguish the two skill families**: this plugin's skills are **operator skills** (used for setup and operations in a human/PM agent's session), while commit/push/land etc. in `packages/cli/src/skills/templates/` are **worker-injected skills** (injected into worker worktrees per D5). They are different layers with different distribution paths.

### B2. Bootstrap default = standalone mode

- The bootstrap output is **project folder creation**, not repo commits: `WORKFLOW.md` (front matter manifest) + `.mcp.json` + `.env` + `.agent/skills/`. The repo knows nothing (repo-unaware).
- repo-embedded is kept as an explicit option (`--mode repo-embedded`).
- The `activate` stage changes from "run the CLI in the repo" to **project registration** (supervisor / CLI `project add`).
- Added to the discovery stage: checking for existing project folders, the bare cache (`~/.gh-symphony/repos/`), and daemon/supervisor status.

### B3. Align configuration artifacts with the D1 conventions — retire the `.gh-symphony/*.yaml` split

The `.gh-symphony/context.yaml` / `lifecycle.yaml` / `actions.yaml` split invented by the skills is a self-made convention outside the spec and conflicts with D1 (front matter = manifest). Relocation:

| Old (skills v0.1.0)                                          | New location                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `context.yaml` (repo/tracker/project id/readback)            | WORKFLOW.md front matter (`tracker`, `repository` extension key)                                |
| `lifecycle.yaml` (states, active/wait/terminal, transitions) | front matter `tracker.active_states`/`terminal_states` + core `WorkflowLifecycleConfig` mapping |
| `actions.yaml` (pick/implement/open_pr/land/block rules)     | WORKFLOW.md body (prompt policy — belongs to the Policy layer to begin with)                    |
| `pm.yaml`                                                    | moved to the steward workspace (B4)                                                             |

The lifecycle skill's state model itself (7 states, In review = waits for a human, Land = landing queue, readback principle) is **kept as-is** — only the storage location changes.

### B4. PM steward = generalization of the maintenance pattern, with execution delegated to Symphony

The steward is a PM agent with its **own git-managed workspace** (inheriting the maintenance structure: a LOOP.md-style cycle definition, a MAPPING.md-style index of managed targets, `state/`, `docs/decisions/`).

The decisive difference from maintenance: **the implementation delegation target is Symphony, not codex exec.** The maintenance loop combined PM and execution orchestration in one session, but on top of Symphony execution belongs to the orchestrator/workers, so the steward's role narrows to:

1. **Intake** — human request → issue draft → (after approval) tracker registration
2. **Triage/promotion** — Backlog grooming, Ready promotion recommendations (approval gate kept)
3. **Review coordination** — requesting reviews, detecting CHANGES_REQUESTED → driving worker rework via state transitions
4. **Landing relay** — recommending the Land move for approved PRs (human approval gate)
5. **Monitoring & reporting** — cycle reports measured against the supervisor status API + the tracker (Slack thread)
6. **Anomaly detection** — promoting stale/blocked/orchestrator-degraded conditions to the decision queue

The steward runner is designed to be **agnostic**: whether a `/loop` session or a Hermes cron, it operates under the same contract (self-contained prompt + `pm.yaml` policy + `state/`). The steward skill's permission levels 0–4 and the allowed/forbidden transition table are kept.

### B5. Promote the maintenance-distilled rules into the steward contract

Codify the rules born from real incidents as general conventions:

- **Single input collection** — a cycle start is judged only from the output of a single collection script/command
- **Duplicate-loop lock** — a session lock in the steward workspace's `state/`
- **No speculative reporting** — external state is measured at reporting time; when measurement is impossible, explicitly state "unverified"
- **Record human decisions immediately** — the `docs/decisions/` convention
- **The 3 gates** — assignment gate, double approval gate (Ready promotion, Land merge), no destruction + a permission probe before starting

## Per-Skill Update Points (v0.1.0 → v0.2.0)

### Common

- [ ] Remove all references to `.gh-symphony/context.yaml`/`lifecycle.yaml`/`actions.yaml` → B3 relocation
- [ ] Artifact location: inside the repo → the project folder (standalone default, repo-embedded as an option)
- [ ] Tracker default: the skills still carry a Linear-centric assumption, but the current implementation is primarily GitHub Projects V2 — realign to the current implementation

### `github-symphony-bootstrap`

- [ ] Hard rule 4 "Prefer one GitHub Symphony instance per repository" → **"1 project = 1 instance, 1 repo : N projects allowed"** (D2, D7). Add the scenario of layering a second project onto the same repo as a supported flow
- [ ] Add to Phase 1 discovery: scan for existing project folders, presence of the `~/.gh-symphony/repos/` bare cache, daemon/supervisor liveness, and a **tracker-mapping disjointness check** (same logic as the D7 registration validation — warn on overlap with existing projects)
- [ ] Phase 6 apply-local: replace the output files with `WORKFLOW.md`+`.mcp.json`+`.env`+`.agent/skills/`; `.env` is 0600 + no literal tokens, with `$VAR` guidance (D6, D9)
- [ ] Phase 9 activate: redefine as `gh-symphony project add` (supervisor registration) + daemon startup + status server readback
- [ ] Shadow warning: if the repo already has a WORKFLOW.md, state the shadowing fact in the plan when in standalone mode (D3)

### `github-symphony-workflow-author`

- [ ] Output: consolidate into a single WORKFLOW.md (front matter = the old context+lifecycle, body = the old actions policy prose)
- [ ] Include the `repository` extension key and `workspace.root` in the front matter (D1, D4)
- [ ] Branch naming default `feat/<issue-number>-...` → **`symphony/<project-slug>/<issue-id>`** (D8 — state explicitly that this is a worktree branch-uniqueness constraint of the shared bare clone, not a style choice)
- [ ] Keep the PR policy prose (the issue closing section, validation section, the rule to collect review inline comments separately, etc. — proven content)

### `github-symphony-project-lifecycle`

- [ ] Keep the state model, validation rules, and readback principle (the skill needing the fewest updates)
- [ ] Change only the output target: `lifecycle.yaml` → front matter + core `WorkflowLifecycleConfig` (state the mapping to the planning→human-review→implementation→awaiting-merge→completed execution phases)
- [ ] Add a validation item: a state-mapping conflict check against other projects sharing the same repo

### `github-symphony-project-steward`

- [ ] `pm.yaml` location: `.gh-symphony/pm.yaml` (repo) → the steward workspace (B4). PM state too: `.gh-symphony/state/` → the workspace's `state/`
- [ ] Monitoring target: a single repo → **a list of projects** (the supervisor status API is the primary source, tracker measurement is secondary)
- [ ] Cron prompt template: based on the repo workdir → based on the steward workspace + project index
- [ ] Fold the 5 B5 rules into the Hard Safety Rules (single input collection, duplicate lock, no speculative reporting, decision recording, gates)
- [ ] State runner agnosticism: remove Hermes-cron-only wording, restate as a contract common to `/loop` and cron

## Target Structure (Plugin & Steward)

```
github-symphony monorepo
  plugins/gh-symphony/                 # B1: plugin source (Claude Code plugin format)
    skills/
      github-symphony-bootstrap/
      github-symphony-workflow-author/
      github-symphony-project-lifecycle/
      github-symphony-project-steward/

<steward workspace>/                   # B4: maintenance generalized (git-managed)
  LOOP.md                              # cycle definition (runner-agnostic)
  pm.yaml                              # PM policy (permission levels, allowed transitions, cadence)
  projects-index.md                    # index of supervised projects (formerly MAPPING.md)
  docs/decisions/                      # human decision records
  state/                               # loop lock, baselines, cursors
```

## Open Questions

1. **Plugin format details** — Claude Code marketplace metadata, versioning policy, install UX (`/plugin install`?). Finalize the Codex distribution mechanism (skill rendering path)
2. **Steward ↔ supervisor API dependency** — the status aggregation API shape used as the primary monitoring source is defined in the supervisor spec. Until then the steward must be able to operate on tracker measurement alone (phased dependency)
3. **Standard location of the steward workspace** — placed alongside the project folders (a sibling of `projects/`) or fully independent
4. **Quality gate for bootstrap's auto-generated WORKFLOW.md** — a verification checklist shared with Control Plane CP2 (front matter parsing, state consistency, passing dispatch preflight)
5. **Whether to migrate the maintenance loop** — moving maintenance itself onto Symphony is a separate decision (currently treated only as a source of patterns)

## Roadmap (proposed)

1. **Phase 1 — migration & update**: move the 4 skills into the monorepo and apply the update points above as v0.2.0 (can precede the standalone model implementation as documentation work; verification only after implementation)
2. **Phase 2 — plugin packaging**: Claude Code plugin format + Codex rendered distribution
3. **Phase 3 — steward generalization**: rewrite the steward skill under the B4/B5 contract, pilot it in maintenance (in parallel with the supervisor spec; API dependency is phased)

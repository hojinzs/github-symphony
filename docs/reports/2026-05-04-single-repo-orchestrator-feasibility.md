# Feasibility Study: Single-Repository Orchestrator Model

- **Date**: 2026-05-04
- **Author**: hojinzs@gmail.com (with Claude assist)
- **Status**: Concluded — promoted to `docs/adr/2026-05-04_single-repo-orchestrator.md` and adopted. As this is a point-in-time investigation document, the CLI commands it references (e.g. `gh-symphony start`) reflect the shape before the 2026-05-10 CLI restructuring.
- **Related**:
  - upstream spec: `docs/symphony-spec.md` (Draft v1)
  - reference impl: <https://github.com/openai/symphony> (elixir)
  - PR #255 (Linear adapter ADR draft): `docs/adr/2026-04-29_linear-tracker-integration.md` (in PR)
  - existing ADR: `docs/adr/2026-03-16_issue-centric-state-model.md`
  - gap analysis: `docs/reports/2026-06-25-spec-gap-analysis.md`

> Per-assumption review by Codex (gpt-5-codex via `codex:codex-rescue`) is recorded inline. The Codex outputs are quoted verbatim and condensed; raw transcripts live in the agent task output store.

---

## 1. Background / Motivation

The upstream Symphony spec (`docs/symphony-spec.md` §3, §5) is explicitly a **single-repo + repo-local `WORKFLOW.md`** model. OpenAI's Elixir reference implementation (<https://github.com/openai/symphony/blob/main/elixir/README.md>) also starts with a single command, `./bin/symphony ./WORKFLOW.md`, and assumes one workspace = one repo, with `git clone` happening inside `hooks.after_create`.

However, the current github-symphony implementation embraced as a first-class fact that a GitHub Project V2 can have _multiple linked repositories_, and evolved into a multi-tenant shape (`docs/reports/2026-06-25-spec-gap-analysis.md` D4 — the `<root>/<projectId>/issues/<key>/repository` directory, the `OrchestratorProjectConfig.repositories: RepositoryRef[]` array). As a result:

1. **Conflict with PR #255** — the Linear adapter recommends, as its primary scope, a single-repo mapping: "issues have no repo → inject a single repo from config." The GitHub side uses an array, the Linear side a single value, so the shapes diverge.
2. **Weakened conformance to the upstream spec** — `docs/symphony-spec.md` §5.1 says "the workflow file is expected to be repository-owned"; currently `loadProjectWorkflow` has become a policy-dependent behavior that loads the WORKFLOW.md of `tenant.repositories[0]` or `issue.repository` (`packages/orchestrator/src/service.ts:1100-1140`).
3. **Bootstrap complexity** — a user must go through the GitHub Project ID, projectSlug, and projectConfig directory before they can start. The current repo-centric CLI direction simplifies this path to `cd repo && gh-symphony repo init && gh-symphony repo start`.

---

## 2. Proposed Single-Repo Model

```
$ git clone git@github.com:acme/platform.git
$ cd platform
$ gh-symphony repo init     # Creates WORKFLOW.md if absent, recognizes it if present. Validates tracker auth.
$ gh-symphony repo start    # Starts polling, using this repo's WORKFLOW.md as policy.
```

Key changes:

- `OrchestratorProjectConfig.repositories: RepositoryRef[]` → a single `repository: RepositoryRef` field.
- The primary source of `WORKFLOW.md` is the **cwd (or an explicitly specified repo directory)**. If the user overrides with `--workflow-file <path>`, that path takes precedence (already spec §5.1).
- Directory layout: `.runtime/orchestrator/<workspaceKey>/...` (or `.runtime/orchestrator/issues/<workspaceKey>/...`) — the `<projectId>` level is removed.
- CLI: `init`/`start`/`status`/`stop` become cwd-based. `--project-id` disappears or becomes internal-only.
- tracker config: `tracker.settings.repository = "owner/repo"` becomes the common shape for both GitHub and Linear.

This model fits spec §3.1 and §5.1 exactly, and if you want to operate multiple repos on one machine, you multiplex externally with the **"one service instance per repo"** pattern. (= the unix way; if you run only one Linear, that's one instance too.)

---

## 3. Per-Assumption Evaluation + Codex Review

### A1 — Implementability

> Assumption: the multi-repo assumption is superficial, and flattening `repositories: RepositoryRef[]` → `repository: RepositoryRef` loses almost no meaning.

**My analysis**: The issue/run/workflow processing paths effectively all operate under a single-repo assumption already (`run.repository` is always singular, and `loadProjectWorkflow` uses the first repo or `issue.repository`).

**Codex review result (verdict: partially correct)**:

> "issue/run/workflow themselves are single-repo-centric, but project-wide policies (poll interval, concurrency) aggregate (min/merge) over the entire `tenant.repositories` array."
>
> Hidden coupling:
>
> - `packages/orchestrator/src/service.ts:2527` — poll interval aggregated as the min across all repos
> - `packages/orchestrator/src/service.ts:2546` — concurrency policy merged/min'd across multiple repos
> - `packages/orchestrator/src/service.ts:825` — startup terminal cleanup iterates over all resolved repos
>
> Confidence: medium.

**Interpretation**: The flattening is semantically possible, but ~3 pieces of policy-aggregation logic sit on top of the array assumption. Going single-repo **simplifies** these aggregation functions (min(x) → x). In other words, removing the array actually reduces code rather than losing any new capability. The single-issue-repository contract is already stable.

---

### A2 — Effort Size

> Assumption: core changes + test fixtures + one-time migration = **30–50 hours (3–7 days)** / 1 person.

**My analysis**: ~10–15 key files. ~10 references to `tenant.repositories` in service.ts (3,381 LoC). Updating the fixtures in service.test.ts (2,753 LoC) is the largest cost.

**Codex review result (verdict: optimistic)**:

> "The production-code delta (`status-surface.ts:15-21`, `fs-store.ts:43-188,297-346`, `service.ts:868-946,2527-2638`) is estimated at **700–1,100 LoC**, and **64 of 94 tests in `service.test.ts` embed `tenant-1`/project paths**, so 30–50h is tight."
>
> Bigger-than-expected surface:
>
> - `packages/core/src/contracts/state-store.ts:11-40` — the store API fixes `projectId` as a required parameter
> - `packages/core/src/workspace/identity.ts:12-14,43-60` — `projectId` is baked into workspace paths/keys
> - `packages/dashboard/src/store.ts:33-47` — the control-plane `/api/v1/state` server-path dependency is deeper than expected (the client is shallow, but the server store is not)
>
> Hidden test debt: `e2e/seed/config.json:1-11` hardcodes a single repo + `e2e-project`, so the e2e burden is small, but the size of the `service.test.ts` fixture chain is hidden debt.
>
> **Better effort estimate: 55–80h.** Confidence: medium-high.

**Interpretation**: Estimate revised upward. 60–80h (1.5–2 weeks) is more realistic. Reasons: the embedding of `projectId` in the state-store contract and identity utilities, plus the service.test.ts fixture chain.

---

### A3 — Architectural Simplification

> Assumption: the single-repo transition (i) compresses the key scheme, (ii) removes control-plane `projectId` routing, (iii) synergizes with the issue-centric ADR (`2026-03-16`) → meaningful maintainability improvement.

**My analysis**: The key scheme flattens from (projectId × repositoryId × workspaceKey) → (workspaceKey). The control plane's `projectId` argument (`ControlPlaneServerOptions.projectId` in `packages/control-plane/README.md` §1.4) disappears. Among the spec divergences (D1–D6), D4 is resolved and the spec §3.1 layer separation becomes clearer.

**Codex review result (gain: medium, synergy: present)**:

> "**Simplification gain: Medium** — `projectId` is pervasive but mostly namespace/routing glue; the harder repo/tracker/run logic stays regardless.
>
> Lost capabilities:
>
> - Multi-repo project configs via `repositories: RepositoryRef[]` (one orchestrator spanning N repos is gone)
> - Runtime root partitioning across multiple `projects/<projectId>` directories (one service per repo becomes the model)
>
> **Synergy with issue-centric ADR: Synergy** — ADR already moves state toward issue keys/workspaces; flattening removes the remaining project namespace layer.
>
> **Risk of premature collapse: Medium** — current CLI/tests explicitly support multi-repo; reintroducing it later would be real feature work, partly mitigated by the one-service-per-repo pattern.
>
> Confidence: Medium."

**Interpretation**: The simplification gain is clear but "medium," not "high" — the hard logic (repo/tracker/run) itself remains. The two lost capabilities must be acknowledged as real costs:

- The scenario of one orchestrator instance spanning N repos → multiplexed via one instance per repo.
- The `<projectId>` partitioning under a single `.runtime/` → separated via per-instance `--runtime-root`.

For users who genuinely need multi-repo management, "external multiplexing" becomes the answer (spinning up instances via docker/systemd units). This is unix-style and fits the spirit of the spec/reference as well.

---

### A4 — Compatibility with PR #255

> Assumption: the single-repo transition dovetails with PR #255's single-repo mapping recommendation, so the GitHub/Linear adapters share the same contract. Cost decreases or stays the same.

**My analysis**: The PR #255 ADR explicitly scopes "Linear issues have no repo concept → `tracker.settings.repository = \"owner/repo\"`" as its primary scope. If GitHub keeps the array, the two adapters' shapes diverge. Unifying eliminates per-adapter branching.

**Codex review result (verdict: partially correct)**:

> "Based on the types read, `TrackedIssue.repository` / `OrchestratorRunRecord.repository` are already a single `RepositoryRef`, but `OrchestratorProjectConfig.repositories` is an array, so only the flattening of the issue/run output layer matches the common contract.
>
> **Contract unification benefit:**
>
> - With a single `issue.repository`, the orchestrator can build workspace/run environments without per-adapter branching
> - `reviveIssue(project, run)` also restores the same `TrackedIssue` shape from `run.repository`
>
> **Phase 3 risk** (label-based multi-repo routing): label-based routing must select a single `RepositoryRef` _before_ the `TrackedIssue` is created, so it does not roll back the single-issue-repository contract itself.
>
> **Recommendation for PR #255:** merging it and the single-repo GitHub transition are independent. However, if the PR attempts to change the core config to a single repo, that warrants a separate review.
>
> Confidence: medium."

**Interpretation**: The two efforts can proceed orthogonally. Phase 3 label routing is routing logic _inside_ the tracker adapter, not a repo dimension in the orchestrator core, so it does not break the single-issue-repository contract. If the single-repo transition lands before PR #255 solidifies into a formal ADR, PR #255 merely becomes a bit simpler — there is no dependency.

---

## 4. Key Change Surface (with Codex additions)

| Area          | Files                                                                                    | Change                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Contract      | `packages/core/src/contracts/status-surface.ts:15-21`                                    | `repositories: RepositoryRef[]` → `repository: RepositoryRef`                                                    |
| Contract      | `packages/core/src/contracts/state-store.ts:11-40`                                       | Remove or make optional the `projectId` parameter in the store API                                               |
| Identity      | `packages/core/src/workspace/identity.ts:12-14,43-60`                                    | Remove `projectId` from workspace paths/keys. Unify with `deriveWorkspaceKey(identifier)` from ADR `2026-03-16`. |
| Orchestrator  | `packages/orchestrator/src/service.ts:825,868-946,2527-2638`                             | Array aggregation (min/merge) → direct use. Simplify the tenant model.                                           |
| Orchestrator  | `packages/orchestrator/src/fs-store.ts:43-188,297-346`                                   | Disk layout `.runtime/orchestrator/<workspaceKey>/...`.                                                          |
| Orchestrator  | `packages/orchestrator/src/git.ts:116-134`                                               | No change (already single repo).                                                                                 |
| Tracker       | `packages/tracker-github/src/orchestrator-adapter.ts`                                    | Unify to the `tracker.settings.repository = "owner/repo"` shape.                                                 |
| CLI           | `packages/cli/src/commands/{init,start,project,repo}.ts`                                 | cwd-based behavior. Remove or hide the `--project-id` option.                                                    |
| Control plane | `packages/control-plane/src/server.ts`, `packages/dashboard/src/store.ts:33-47`          | Remove `projectId` routing.                                                                                      |
| Tests         | `packages/orchestrator/src/service.test.ts` (94 suites, 64 tests affected), e2e fixtures | Update the fixture chain.                                                                                        |

Plus the ADR document + spec gap analysis update + migration script.

---

## 5. Migration / Existing Data

Existing users have a `.runtime/orchestrator/projects/<projectId>/...` directory. Two options:

1. **Automatic migration script** — during `gh-symphony repo init`, if a single `<projectId>/` is found, promote its contents to the `.runtime/orchestrator/` root, keeping the `projectId` field in run records (for compatibility). If multiple `<projectId>/` directories are found, require an explicit user choice (or guide toward instance separation).
2. **Breaking change + fresh start** — create a new runtime directory and leave the old one as a read-only archive.

Recommendation: (1). Since this is a PR that reduces spec divergence, minimize user friction.

---

## 6. Risks

- **Premature collapse risk: medium** (codex). The scenario of one instance spanning N repos is explicitly supported by the current code/tests. If genuine multi-repo becomes needed again in the future, the "one instance per repo" workaround could get awkward. That said, this is the standard trade-off that most single-tenant tools answer the same way.
- **Test debt (codex A2)**: the `service.test.ts` fixture chain. The main reason for the upward revision of the estimate (60–80h).
- **Control-plane server store dependency (codex A2)**: the server-side `projectId` dependency in `packages/dashboard/src/store.ts` is deeper than the client's. Part of the UI is affected simultaneously.
- **Alignment with PR #255** — deciding this transition before PR #255 merges makes the PR #255 ADR text simpler (Linear/GitHub the same shape). It can also proceed in parallel after the merge.

---

## 7. Conclusion / Recommendation

| Question                                                | Answer                                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Is the change feasible from the current implementation? | **Yes** — a surface change. The policy-aggregation logic (min/merge) simplifies as a result.                                              |
| How much effort does the change take?                   | **60–80h (1.5–2 weeks) / 1 person** — Codex revised upward.                                                                               |
| Does the architecture get simpler?                      | **Medium simplification** — key-scheme compression + control-plane routing removal + ADR synergy. However, the hard logic itself remains. |

**Recommended next steps**:

1. Promote this document to an ADR (`docs/adr/2026-05-04_single-repo-orchestrator.md`) followed by a decision gate.
2. If the decision is "go," split in the following order:
   - (P1) Contract changes + identity util unification + adopting `deriveWorkspaceKey` from ADR `2026-03-16`
   - (P2) Simplify service.ts policy-aggregation logic + fs-store layout change
   - (P3) CLI cwd-based flow + migration script
   - (P4) Remove server-side `projectId` from control-plane / dashboard
   - (P5) Bulk test-fixture update + e2e validation
3. Proceed orthogonally to PR #255 — although if this transition lands first, the GitHub/Linear contract-unification wording in the PR #255 ADR becomes more natural.

---

## Appendix — Codex Review Meta

- All 4 items were sent to `codex:codex-rescue` (gpt-5-codex) for independent second opinions.
- A3 stalled on the first attempt → retried with a shorter prompt and received a response.
- No verdict is "high confidence" — all are "medium" — meaning this document is **for directional alignment**, and it is recommended to get one more round of Codex/reviewer alignment at the ADR stage before entering actual implementation.

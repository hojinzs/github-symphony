# docs/

Document placement rules and index. When adding a new document, place it
according to the categories below. All internal documents are written in
English.

## Placement rules

| Location         | Nature                                                                           | Rules                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/` root     | **Living documents** — hold the truth of current behavior, updated continuously  | No date prefix. When code changes, the document must change with it                                                                                                                                               |
| `docs/adr/`      | **Decision records** — why it was done this way                                  | `YYYY-MM-DD_slug.md`. Not edited after the decision; to reverse one, supersede it with a new ADR                                                                                                                  |
| `docs/designs/`  | **Pre-implementation designs and plans** — what to build and how (point-in-time) | `YYYY-MM-DD-slug.md`. The header must carry `Status` (Draft → Approved → Shipped/Abandoned) and `Symphony Layers` (list the layers involved). After shipping, update only the Status and keep the body as history |
| `docs/reports/`  | **Point-in-time analysis** — audits, feasibility studies, RCAs                   | `YYYY-MM-DD-slug.md`. A snapshot of when it was written. The body is not kept current; follow-ups link only from the header status line                                                                           |
| `docs/examples/` | Example files for users                                                          | Keep consistent with actual behavior                                                                                                                                                                              |

`Symphony Layers` follows the six-layer classification defined by `AGENTS.md`
(Policy / Configuration / Coordination / Execution / Integration /
Observability). Designs usually span multiple layers, so they are tagged via
header metadata rather than directories.

## Living documents

- [symphony-spec.md](symphony-spec.md) — upstream Symphony spec, synced verbatim from [openai/symphony `SPEC.md`](https://github.com/openai/symphony/blob/main/SPEC.md) @ `8001b52` (2026-08-12). **Read-only, never modify** — resync only via a dedicated PR
- [architecture.md](architecture.md) — maps spec components (§3.1) and layers (§3.2) to packages. Organized as per-layer slices; PRs that move code across layers/packages update the matching slice
- [configuration.md](configuration.md) — configuration and environment variable reference (env loading order, standalone projects, skill layering)

Architecture documentation scoped to a single package lives in that package's
`README.md` (for example [packages/control-plane/README.md](../packages/control-plane/README.md)).

## trackers/

Provider-specific compact adapter profiles and host-side agent-tool contracts:

- [GitHub Project](trackers/github-project.md) — configuration, normalization, and `github_graphql`
- [GitHub tool](trackers/github.md) — standalone `github_graphql` tool contract
- [Linear](trackers/linear.md) — configuration, normalization, and `linear_graphql`
- [File](trackers/file.md) — local/Docker E2E fixture adapter profile

## designs/

| Document                                                                                                                     | Layers                                                        | Status            |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| [2026-05-10-cli-restructure-design.md](designs/2026-05-10-cli-restructure-design.md)                                         | Coordination, Configuration                                   | Shipped           |
| [2026-05-10-cli-restructure-issues.md](designs/2026-05-10-cli-restructure-issues.md)                                         | Coordination, Configuration                                   | Completed (plan)  |
| [2026-07-06-github-project-repo-dispatch-filter-design.md](designs/2026-07-06-github-project-repo-dispatch-filter-design.md) | Integration, Coordination, Observability                      | Shipped (PR #435) |
| [2026-08-11-standalone-project-model-design.md](designs/2026-08-11-standalone-project-model-design.md)                       | Policy, Configuration, Coordination, Execution, Observability | Shipped           |
| [2026-08-11-agent-bootstrap-plugin-pm-steward-design.md](designs/2026-08-11-agent-bootstrap-plugin-pm-steward-design.md)     | Policy, Configuration, Coordination, Observability            | Draft             |
| [2026-08-11-standalone-project-model-issues.md](designs/2026-08-11-standalone-project-model-issues.md)                       | (plan)                                                        | Active            |

## reports/

| Document                                                                                                         | Status                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [2026-09-05-maintainability-and-reliability-review.md](reports/2026-09-05-maintainability-and-reliability-review.md) | Review complete — proposed fixes and trade-offs for CI, orchestration, storage, and Linear normalization |
| [2026-05-04-single-repo-orchestrator-feasibility.md](reports/2026-05-04-single-repo-orchestrator-feasibility.md) | Concluded — promoted to an ADR                                                         |
| [2026-06-25-spec-gap-analysis.md](reports/2026-06-25-spec-gap-analysis.md)                                       | Retired — living-map upkeep stopped, final snapshot                                    |
| [2026-07-06-risk-audit-report.md](reports/2026-07-06-risk-audit-report.md)                                       | Awaiting review (issues not filed)                                                     |
| [2026-07-19-github-api-rate-limit-audit.md](reports/2026-07-19-github-api-rate-limit-audit.md)                   | Partially implemented (R1.5 shipped)                                                   |
| [2026-08-28-upstream-spec-drift-research.md](reports/2026-08-28-upstream-spec-drift-research.md)                 | Complete (Epic #651 scope) — see its documented carve-outs; C1–C13/D1–D8 follow-up shipped in [#675](https://github.com/hojinzs/github-symphony/issues/675) |

## adr/

See the [adr/](adr/) directory for the ADR list. When a newer decision replaces
an older one, they are linked via the `Supersedes` header.

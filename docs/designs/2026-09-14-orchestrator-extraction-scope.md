# Orchestrator extraction scope

- **Status:** Draft
- **Date:** 2026-09-14
- **Symphony Layers:** Configuration, Coordination, Execution, Integration, Observability
- **Issues:** [#890](https://github.com/hojinzs/github-symphony/issues/890), [#897](https://github.com/hojinzs/github-symphony/issues/897), [#898](https://github.com/hojinzs/github-symphony/issues/898)

## Decision

Keep `OrchestratorService` as the public, effect-owning Coordination façade and
extract only cohesive decisions with explicit immutable inputs and outputs.
Extraction is for ownership clarity, not line-count reduction. It must not
introduce a second scheduler, retry queue, workspace-population path, state
store, tracker client, or metrics pipeline.

The first implementation slice, [#898](https://github.com/hojinzs/github-symphony/issues/898),
extracts retained retry and finalization decisions. Workspace preparation and
run reconciliation remain in the façade until later designs can name an
effect boundary without duplicating state or work already assigned to hooks.

## Upstream boundary and current invariants

This is a repository-local decomposition of the implementation described by
the upstream spec; it does not change `docs/symphony-spec.md` or introduce a
new divergence. The following contracts remain fixed:

- **Configuration:** the currently loaded workflow and its last-known-good
  behavior remain the source of lifecycle, retry, concurrency, and hook policy.
- **Coordination:** one façade owns claims, dispatch reservations, reconciliation,
  retry queues, concurrency accounting, process ownership, and effect order.
  Reconciliation requests and tracker-state requests remain separate queues.
- **Execution:** one issue maps to one contained workspace, and hooks retain
  their ordering. The project `after_create` hook owns optional repository
  population and synchronization; extraction must not recreate clone, fetch,
  checkout, cache, or worktree population in an orchestrator collaborator.
- **Integration:** adapters fetch and normalize tracker state and declare their
  credential environment names. Pure decisions receive normalized values; they
  do not call providers or inspect provider-native payloads.
- **Observability:** persisted run/workspace/issue-orchestration schemas, retry
  attempts and due times, event names and order, metrics, status snapshots, and
  diagnostics remain unchanged.
- Required safety behavior remains intact: workspace containment and reuse
  rules, terminal cleanup, retry budget accounting, credential stripping and
  its compatibility backstop, host-owned fast-forward publication, dirty-workspace
  recovery, and unpublished-work retention. Existing documented divergences
  are preserved rather than reconsidered here.

## Responsibility map

| Responsibility                                                                                                                                       | Disposition             | Owner after the planned extraction                                             | Boundary                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow loading, reload, and last-known-good selection                                                                                              | Retain                  | `OrchestratorService` plus existing workflow helpers                           | Supplies resolved policy to decisions; no new configuration cache                                                                                   |
| Candidate polling, claims, concurrency reservations, dispatch, and process lifecycle                                                                 | Retain                  | `OrchestratorService`                                                          | Sole writer of coordination state and sole effect sequencer                                                                                         |
| Retry queue records, timers, store writes, tracker refresh, cleanup, and worker restart                                                              | Retain                  | `OrchestratorService` and existing store/adapter interfaces                    | Decisions return intent; the façade performs all I/O and mutation                                                                                   |
| Retry restart disposition after refresh                                                                                                              | Extract                 | Focused pure decision module in `packages/orchestrator`                        | Normalized workflow availability, item presence, terminality, and eligibility in; an explicit restart, release, or requeue intent out               |
| Retry budget, attempt, suppression, delay class, and due-time choice                                                                                 | Extract                 | Same focused decision module                                                   | Explicit counts, limits, retry kind, policy, and clock in; next retry record intent out                                                             |
| Retry reservation capacity and deterministic ordering                                                                                                | Extract or consolidate  | Same module, reusing `sortRunsForReconciliation` rather than competing with it | Records, concurrency, and clock in; ordered IDs/capacity decision out                                                                               |
| Successful-run finalization disposition                                                                                                              | Extract                 | Same focused decision module                                                   | Normalized tracker progress, deferral count/bound, exit facts, publication result, and recovery presence in; complete/defer/failure-path intent out |
| Run/workspace/issue-orchestration persistence                                                                                                        | Retain                  | Existing stores called only by the façade                                      | No schema, serialization, migration, or write-order change                                                                                          |
| Tracker reads, mutations, rate-limit handling, and provider semantics                                                                                | Retain                  | Tracker adapters and existing host tool boundary                               | No provider dependency in extracted decisions                                                                                                       |
| Hooks and workspace lifecycle effects                                                                                                                | Retain                  | Existing hook runner and façade                                                | Population stays exclusively in `after_create`                                                                                                      |
| Event writes, logs, metrics, and status projection                                                                                                   | Retain                  | Existing observability paths invoked by the façade                             | Decisions do not emit; the façade preserves names, payloads, and order                                                                              |
| Legacy repository-population, credential-broker, quarantine/attribution, registry, or orchestrator-authored-comment responsibilities removed by #847 | Remove / do not restore | None                                                                           | Deleted scope is not an extraction candidate                                                                                                        |

“Extract” means move a calculation behind a typed function, not transfer
ownership of mutable state. A helper must not receive `OrchestratorService`, a
store, an adapter, callbacks that conceal effects, or a broad mutable context.
Its output is a discriminated decision that the façade applies.

## Q8: first retained pure decisions

[#898](https://github.com/hojinzs/github-symphony/issues/898) should start with
the following two tightly related families:

1. **Finalization disposition.** Given the normalized final tracker-progress
   result, current deferral count and bound, worker exit facts, Git publication
   outcome, and whether dirty-workspace recovery exists, decide among:
   `complete`, `defer-finalization`, or `enter-failure/continuation-retry`.
   The façade continues fetching tracker state, persisting the incremented
   deferral, emitting `run-finalization-deferred`, and applying the selected
   intent. Below the deferral bound, `defer-finalization` retains the claim and
   leaves both the run and issue-orchestration records `running`; it must not
   make the issue eligible for another dispatch into the live workspace. Claim
   release belongs only to `complete` and the failure/continuation path,
   including the fall-through after the deferral bound is exhausted.
2. **Retry record disposition.** Given retry kind, recovery presence, current
   attempt and durable failure count, maximum failure retries, retry policy,
   current time, and any retained reservation due time, decide suppression,
   next attempt, whether the failure budget advances, delay class, and
   `nextRetryAt`. The façade continues writing run and orchestration records,
   scheduling timers, emitting events, and starting workers.

Q8 may also relocate or consolidate the already-pure deterministic
`sortRunsForReconciliation` and retry-capacity calculation when that reduces
duplication within the same size bound. It must reuse the established ordering:
non-due active runs first, then due retry reservations by due time, issue
identifier, and run ID. If all three pieces do not fit a medium change, Q8
narrows to finalization plus retry-record disposition; reservation ordering
stays in place for a separately approved child.

The façade-level tests remain regression contracts. Focused table tests are
added for the extracted functions, especially:

- unknown final tracker state below the deferral bound retains the claim and
  leaves both records `running`; at the bound it falls through to the
  failure/continuation intent;
- successful non-actionable completion versus active continuation;
- continuation, recovery, and failure attempt accounting;
- failure-budget suppression at the exact bound;
- retained due time when capacity postpones a reservation; and
- deterministic ordering and capacity without double-counting the retry's own
  reservation.

## Overlap and sequencing

- **#847 — spec-footprint epic:** establishes the governing direction and has
  already moved repository population to the shipped `after_create` hook while
  removing unrelated responsibilities. This design starts from that landed
  boundary. It does not extract the former population implementation or add a
  `WorkspacePreparer` that clones or synchronizes repositories.
- **#844 — child environment boundary:** centralizes construction and stripping
  at the agent-child boundary. Orchestrator decomposition must call that
  existing boundary and must not grow a parallel environment/credential
  abstraction.
- **#879 — credential declaration/backstop contract:** preserves the
  adapter-declared secret provenance and the unconditional seven-name core
  compatibility backstop. That intentional safety divergence remains, and
  extraction must not reinterpret it as decision logic to remove.

The prerequisite implementations for #871 and #879 are merged. Q8 remains
sequenced after this design and its other declared dependencies; conditional
overlap with sibling implementation work is resolved by narrowing Q8 rather
than widening this design.

## Non-goals

- Rewriting the orchestrator as actors, a workflow engine, or distributed
  services.
- Changing the public façade, tick ordering, queue ownership, persistence
  format, event schema, retry policy, concurrency behavior, or metrics.
- Extracting effectful workspace preparation or full run reconciliation in Q8.
- Reintroducing repo mode, repository caches, worktree population, credential
  brokers, workspace quarantine/attribution, instance registries, or
  orchestrator-authored tracker comments.
- Removing a safety contract because its original subsystem was removed.
- Editing or redefining the upstream Symphony specification.

## Validation and rollback

Q8 must keep the existing service tests at the façade boundary and add focused
tests for each pure decision. Its required validation remains `pnpm lint`,
`pnpm test`, `pnpm typecheck`, and `pnpm build`, plus the applicable CI
container checks named by #898. A safe rollback moves the pure calculations
back into the façade without any data migration because this design adds no
state or wire format.

This design itself is documentation-only. It was checked against the current
implementation, the upstream layer and workspace/retry contracts, the
maintainability review, the credential-broker footprint, and issues #844,
#847, #879, and #898.

# ADR: Use per-tick workflow detection instead of a filesystem watcher

- **Date**: 2026-08-26
- **Status**: Accepted
- **Related Issue**: #626
- **Related Spec**: `docs/symphony-spec.md` §6.2, §16.1, §17.1, §18.1

## Context

The upstream specification requires a `WORKFLOW.md` filesystem watch that
reloads and re-applies policy without a restart. The repository has no such
watcher. Instead, `WorkflowConfigStore.load` reads the file on each call, and
the orchestrator's per-tick workflow-resolution cache is created for one
reconciliation and cleared afterward. Polling interval and concurrency are
therefore resolved again on each tick.

Measured behavior confirms that edits to `polling.interval_ms` and
`agent.max_concurrent_agents` take effect without restarting. A polling change
is visible at the next tick; the old interval remains in force until that tick,
which is bounded by the five-minute maximum poll interval. The worker also
resolves its prompt policy for each dispatched run.

## Decision

Do not add a filesystem watcher. Per-tick defensive detection keeps workflow
policy current while avoiding platform-specific watcher behavior, atomic-rename
handling, duplicate-event debouncing, and a second live-configuration path.

Expose the applied workflow revision in the project status snapshot and in each
`run-dispatched` structured event. The revision is a short SHA-256-derived
identifier of the effective workflow contents; it does not expose workflow text
or environment values. Documentation states the next-tick timing and how an
operator can observe the applied revision.

## Upstream conformance and divergence

This is an explicit repository-local divergence from §6.2 and §16.1's
filesystem-watch mechanism and from §18.1's corresponding conformance item.
The repository satisfies §17.1's observable no-restart acceptance behavior by
detecting, re-reading, and re-applying valid policy at the next reconciliation
tick. It does not promise immediate event-driven re-application.

`docs/symphony-spec.md` remains unchanged.

## Consequences

- Operators can edit valid workflow policy without restarting a daemon.
- The change delay is bounded by the configured, five-minute-capped poll
  interval; lowering the interval takes effect after one final old-interval
  wait.
- Status and dispatch events show which workflow revision is in force.
- Immediate reaction to filesystem writes remains intentionally unavailable.

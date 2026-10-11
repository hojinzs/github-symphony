# Supervised Project Lifecycle — Issue Breakdown Plan

> **Source spec:** `docs/designs/2026-10-11-supervised-project-lifecycle-design.md`
> **Repository:** `hojinzs/github-symphony`
> **Status:** Draft (plan; no issues created). The Epic is opened after Epic #983 completes (D4).
> **Composition:** Epic + 13 children (SL00–SL12)

The design document is the single source of truth. Planning keys `SL00`–`SL12`
are used in issue titles as `[Supervised Lifecycle SLxx]`, following the
`[Control Plane Cxx]` convention. Every child follows the #983 child conventions:
`changeset:patch`, the native parent and blocked-by relations, and the
verification gate below.

## Dependency graph

```
SL00 spike: startup-offline behaviour + OS termination grace   (no deps; informs SL06 guards)

SL01 start record + --start-cause + instanceId ─┐                (no #983 deps)
SL02 stop intent + exit record + classifier ────┤  ← SL01
                                                ├─ SL03 orchestrator OTLP start/stop records ← #995
                                                │
SL04 protocol: supervision, set-autostart, origin, capability   ← #983 complete
                                                │
SL05 agent registry v2 + local intent observation ← SL02, SL04
  └─ SL06 reconciler + guards ← SL05, SL00, C08 (#1012)
       ├─ SL07 agent project autostart|start|stop|list ← C13 (#1017)
       ├─ SL08 agent setup --local + later enroll ← SL07, C11 (#1015), C12 (#1016)
       ├─ SL09 Control Plane: command routing, ingestion, audit origin ← SL04
       │    └─ SL10 UI: desired/observed, autostart toggle, badges ← C16 (#1020), C17 (#1021)
       └─ SL11 agent OTLP resource + metrics ← OTLP Epic #794

SL12 docs, acceptance on real reboots, design status ← all
```

SL00–SL03 do not depend on #983. They can start before the Epic if the OTLP
start/stop records are wanted earlier. The plan assumes they open with the Epic.

## Summary

| Key  | Title                                                            | Layers                      | P / Size | Blocked by         |
| ---- | ---------------------------------------------------------------- | --------------------------- | -------- | ------------------ |
| SL00 | Verify startup-offline behaviour and OS termination grace        | Execution, Observability    | P1 / S   | —                  |
| SL01 | Orchestrator start record, instance identity and `--start-cause` | Execution, Observability    | P1 / S   | —                  |
| SL02 | Operator stop intent, exit record and exit classification        | Execution, Coordination     | P1 / M   | SL01               |
| SL03 | Orchestrator OTLP start/stop log records                         | Observability               | P2 / S   | SL01, SL02, #995   |
| SL04 | Management protocol supervision contracts                        | Integration                 | P1 / S   | #983               |
| SL05 | Agent registry v2: desired state and local intent observation    | Configuration, Coordination | P1 / M   | SL02, SL04         |
| SL06 | Agent reconciler and supervision guards                          | Coordination, Execution     | P1 / L   | SL05, SL00, #1012  |
| SL07 | Agent project supervision commands                               | Configuration               | P1 / S   | SL06, #1017        |
| SL08 | Local-only agent setup and later enrollment                      | Configuration, Integration  | P1 / M   | SL07, #1015, #1016 |
| SL09 | Control Plane supervision routing, ingestion and audit origin    | Integration, Observability  | P1 / M   | SL04, SL06         |
| SL10 | Supervision UI                                                   | Observability               | P2 / M   | SL09, #1020, #1021 |
| SL11 | Agent OTLP resource and supervision metrics                      | Observability               | P2 / M   | SL06, #794         |
| SL12 | Documentation, reboot acceptance and design status               | All                         | P1 / M   | SL00–SL11          |

## Verification gate

Every child PR must pass:

```bash
pnpm lint && pnpm test && pnpm typecheck && pnpm build
```

It must also add tests covering the SL cases it owns. For SL06–SL08 and SL12,
report real macOS and Linux runs separately from container or fake-clock
simulations.

---

## Epic

**Title:** `[Epic] Supervised project lifecycle — desired state, operator intent and reboot recovery`

- **Background:** Orchestrators do not survive reboot, logout or crash. #983 v1
  explicitly excludes automatic restart. This Epic adds agent-held desired state
  and reconciliation, operator-intent propagation from the local CLI, and a
  local-only agent mode.
- **Decisions:** D1 opt-in supervision, D2 human stop respected and propagated,
  D3 local-only mode, D4 follow-up to #983.
- **Out of scope:** per-project OS units, container supervision, pre-login macOS
  boot, draining, Windows.
- **Labels:** `epic`, excluded from worker pickup.

---

## SL00 — Verify startup-offline behaviour and OS termination grace

Resolve open questions 1 and 2 of the design before the guard values are fixed.

- Measure what `project start --daemon` does when the tracker and GitHub are
  unreachable: does it fail before readiness, retry, or start and degrade?
  Record exit codes and log events.
- Measure the grace period between `SIGTERM` and `SIGKILL` at logout and shutdown
  for a macOS user LaunchAgent and a systemd user service (with and without
  linger). Compare it with the 10 s worker termination plus the 5 s OTLP flush.
- **Acceptance:** findings appended to the design under "Verification" with
  commands and raw evidence. SL06 guard defaults are confirmed or revised in the
  design. No production code.

## SL01 — Orchestrator start record, instance identity and `--start-cause`

- Generate one `instanceId` UUID per orchestrator process and expose it to the
  OTLP resource as `service.instance.id`, replacing any separately generated UUID.
- Write `lifecycle/start.json` (`StartRecord`) atomically once locks are held,
  beside the ready file.
- Add hidden `project start --start-cause <operator|control_plane|agent_cli|boot_recovery|crash_recovery>`,
  default `operator`, forwarded from the daemon parent to the child.
- Resolve the `lifecycle/` directory through the same canonical runtime used by
  `resolveCanonicalRuntime` (design open question 4).
- **Acceptance:** start record written for foreground and daemon modes. The cause
  is forwarded in daemon mode. Invalid values are rejected. The record is not
  written when the start loses the lock race.

## SL02 — Operator stop intent, exit record and exit classification

- `project stop` (folder and expected-target modes, including `--force`) writes
  `lifecycle/stop-intent.json` before signalling. The expected-stop socket path
  records `requestedBy` and `commandId` when called by the agent.
- The orchestrator writes `lifecycle/last-exit.json` (`ExitRecord`) on graceful
  shutdown, lease loss and fatal startup/runtime errors, best effort.
- Add a shared, pure `classifyExit(start, intent, exit)` reader in a package the
  management agent already depends on. Resolve the exact location in the
  implementation plan.
- Archive consumed intents to `lifecycle/history/` (last 20) on the next
  successful start.
- `project status` shows last exit reason and start cause.
- **Acceptance:** SL-05 and SL-11 logic at unit level; intent written before the
  signal (fault-inject a crash between write and signal); stale intent ignored;
  records redacted.

## SL03 — Orchestrator OTLP start/stop log records

- Emit `symphony.orchestrator.started` (`start.cause`, `previous_exit.reason`,
  `previous_instance.id`) and `symphony.orchestrator.stopping` (`stop.reason`,
  `stop.requested_by`) through the gated OTLP log pipeline.
- Disabled OTLP evaluates nothing new.
- **Acceptance:** in-process receiver decodes both records with the expected
  attributes; restart produces a new instance id; existing OTLP acceptance (OT-xx)
  unaffected.

## SL04 — Management protocol supervision contracts

- Add optional `ProjectObservation.supervision`, `LifecycleOperation`
  `set-autostart`, journal/command `origin`, and an agent capability flag in
  `SessionRequest`.
- Validation and schemas, with v1 compatibility in both directions: a v1 Control
  Plane ignores the field, and a Control Plane never sends `set-autostart` to an
  agent without the capability.
- **Acceptance:** schema tests for valid, invalid and absent fields; cross-version
  fixtures.

## SL05 — Agent registry v2: desired state and local intent observation

- Registry `version: 2` with `ProjectSupervision`. Migrate v1 entries to `unset`.
- Read lifecycle records through `LocalReadAdapter` on the observation interval
  and on file-watch events. Apply the "latest human intent wins" table: local stop
  sets `stopped`, local start sets `running`, and nothing changes for `unset`
  projects.
- Journal observed local intents with `origin=local-cli`.
- On agent start, apply pending local intents before any reconciliation.
- **Acceptance:** SL-03, SL-04 and SL-09 at the agent level with fixture records;
  migration test; concurrent writers serialized by the existing registry lock.

## SL06 — Agent reconciler and supervision guards

- Boot pass, observation tick and command-triggered reconciliation, serialized
  per project through the existing lifecycle adapter.
- Guards: boot staggering (2 concurrent, readiness-gated), exponential backoff,
  crash-loop breaker, `blocked_config` released by `workflowRevision` change,
  boot network grace, lease-loss restart. Use the values confirmed in SL00.
- Agent-originated stop writes the stop intent before the expected-target stop.
  Never use `--force`.
- Journal reconciler actions with `origin=reconciler`.
- **Acceptance:** SL-01, 02, 06, 07, 08, 10, 12, 13, 15, 16 with a fake clock and
  stub orchestrators; a real-process test for adoption without restart (SL-16).

## SL07 — Agent project supervision commands

- `agent project add <dir> --autostart`, `agent project autostart <id> on|off`,
  `agent project start|stop <id>`, and `agent project list` with desired,
  observed, supervision state, last exit and restart count.
- Reject `autostart on` when the configured CLI cannot write stop intents.
- **Acceptance:** CLI tests for each command, including the version guard and
  the `autostart on` initial-desired rule.

## SL08 — Local-only agent setup and later enrollment

- `agent setup --local`: prerequisites, C11/C12 service install and start, no
  enrollment, no transport loop. Reports actual auto-start coverage per platform
  (design table).
- `agent enroll` on a local-only agent starts transport without reinstalling and
  preserves desired state, which the first observation reports.
- Warn when a running orchestrator was started by `operator` outside the agent,
  for example by a pre-existing user LaunchAgent script.
- **Acceptance:** SL-14; service install is idempotent; Linux linger-missing
  messaging; macOS LaunchAgent loads at login.

## SL09 — Control Plane supervision routing, ingestion and audit origin

- Route `set-autostart` and supervised start/stop semantics through the command
  ledger. Store and serve `supervision` observations. Show `origin` in audit
  records.
- Capability check before sending `set-autostart`.
- **Acceptance:** ledger and recovery tests for the new operation; ingestion of
  supervision fields; v1-agent compatibility.

## SL10 — Supervision UI

- Desired and observed columns, autostart toggle with confirmation, badges for
  `crash_loop`, `blocked_config` and `backoff`, last exit and restart count, and
  audit origin labels. Follow Graphite (C22) and C14 interaction contracts.
- **Acceptance:** component and interaction tests; screenshots for each state.

## SL11 — Agent OTLP resource and supervision metrics

- Agent config `observability.otlp` block with the same contract shape as the
  orchestrator.
- `service.name=gh-symphony-agent`. Metrics:
  `symphony.project.supervision_state`, `symphony.project.restarts`,
  `symphony.agent.reconcile.actions`, `symphony.agent.reconcile.duration`.
- **Acceptance:** receiver-decoded metrics with expected attributes; disabled
  path loads no OTel modules; restart churn visible in `restarts`.

## SL12 — Documentation, reboot acceptance and design status

- README and CLI docs, operator guide for reboot recovery and local-only mode,
  and migration notes for hand-made LaunchAgent/systemd wrappers.
- Run SL-01–SL-16 end to end. A real reboot is required on macOS and on Linux with
  linger. The Linux no-linger case is documented.
- Update the design status and the #983 design's reboot statement with a pointer
  to this design.
- **Acceptance:** evidence recorded in the Epic; docs index updated; design moved
  to Implemented.

# Local management agent

`@gh-symphony/management-agent` is an internal repository-local management
extension (C03, #1007; Epic #983). It is separate from the shipped per-project
control-plane server and does not schedule or provision projects.

`AgentRegistry.open(dataDirectory)` owns a canonical mode `0700` directory and
uses the existing process-identity heartbeat lock. Call `close()` during shutdown;
a second live instance is rejected. Enrollment and the allowlist are written
atomically, synced, and stored in a mode `0600` registry. Malformed or broadly
readable persisted files fail closed instead of silently discarding identity.

`saveIdentity(httpsOrigin, enrollment)` preserves an enrolled environment/agent
identity and refuses replacement by a different environment, agent or origin.
`add(folder)` registers an existing directory, including unstarted or invalid
workflow folders. Realpath aliases collapse to one entry. Local IDs use the
existing CLI folder-derived algorithm on the canonical path. The fleet server
assigns global project UUIDs and qualifies local IDs by environment.

`resolveManaged(localProjectId)` rechecks the registered path and canonical
folder. A moved folder or retargeted symlink requires local re-registration.
`remove(localProjectId)` revokes new management access without process effects.
Inventory preserves invalid folders and explicitly projects metadata; it excludes
workflow prompts, environment contents, credentials and raw OS command identities.
Process identities uploaded through inventory or lifecycle results are opaque
SHA-256 fingerprints. Raw OS identities stay in local stop targets.

`LocalLifecycleAdapter` consumes a typed `RuntimeDriver` and serializes operations
per local project. Start requires a valid workflow, verified process ownership and
readiness; existing CLI overlap and lock checks remain authoritative. Stop accepts
a `StopTargetJournal` that must durably commit the canonical folder, runtime/config
identity, PID and raw OS identity before any effect. Recovery supplies the saved
target and never substitutes a replacement. Invalid workflows do not block
verified stop. Signal delivery alone is insufficient: completion requires target
exit, both locks released and no replacement process. Unverified completion is
`unknown`; there is no force kill or automatic replay. The default shared effect
and observation deadline is 60 seconds.

The CLI provides the concrete driver in its bundled
`@gh-symphony/cli/management-local` module. It resolves existing alias/legacy runtime
IDs, reads workflow validation and projected run summaries, invokes the configured
absolute executable with argument arrays and ignored stdin, and uses C02's
expected-target stop entry point. `CliProcess` removes management/broker credential
variables and any environment value containing a supplied management credential,
while retaining local project credential resolution. Raw CLI output is never an
uploaded diagnostic.

The factory requires an explicit launch context. Foreground consumers can reuse
ordinary daemon startup. Native service consumers must provide an isolated project
launcher; the factory rejects a native service configuration without one. That
launcher must establish and verify OS isolation in the native service slice before
service packaging. Detached spawning alone does not isolate systemd cgroups. C03
does not install services or claim Linux/macOS service lifecycle validation.

There is no new `gh-symphony agent` command yet. Enrollment transport, durable
command claim/replay journaling, outbound transport and native service packaging
remain separate delivery boundaries. Keep registry/journal backups private because
they contain credentials or raw local process evidence.

Run `pnpm --filter @gh-symphony/management-agent test` for registry, lifecycle and
independent executable-peer contracts; CLI-side inspection tests also verify real
OS process/CWD and ownership records without mocking those probes.

### Verification and acceptance scope

| Requirement                                   | Evidence                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-02 canonical inventory/allowlist           | registry tests; TC-27 real prepared, invalid and aliased folders                                                                                                                 |
| CP-01/14 identity, agent lock, access removal | two independent enrollment fixtures share a local ID with distinct environment identities; private persistent registry and lock tests; TC-27 close/reopen and process continuity |
| CP-03 bounded verified lifecycle              | lifecycle mutations and real invalid-workflow stop with durable target journal                                                                                                   |
| CP-04 local/manual start arbitration          | serialized starts and existing CLI canonical folder lock; TC-27 independent contender                                                                                            |
| CP-15 non-secret metadata/credentials         | typed protocol peer fixture, inventory projections, executable child environment and TC-27 canaries                                                                              |
| Applicable CP-08 recovery                     | exact C02 stop identity retained; TC-27 replacement ownership fault probe                                                                                                        |

TC-27 covers the local portions of operator inventory/start/stop/removal
walkthroughs. Fleet authentication, claim journaling, transport/read handlers and
native systemd/launchd service lifecycle are separate slices; the native launcher
port requires verified isolation instead of assuming detached processes suffice.
Cached aliases restart through their rechecked original path and config root to
preserve runtime IDs and history. Only configured project/workflow paths establish
folder ownership; process CWD never enrolls an unrelated runtime. A retargeted or
missing cached alias is excluded, so launch falls back to the canonical folder.
Missing or inaccessible allowlisted folders return a sanitized `project_unmanaged`
error. CLI status/stop report ambiguous or unreadable runtime lookup failures with
a diagnostic and exit code 1.

## Bounded local reads (C09)

`LocalReadAdapter` accepts the management protocol's typed read request and a
trusted `LocalReadRuntimeResolver` supplied by the CLI. The bundled
`@gh-symphony/cli/management-local` module provides
`createLocalReadAdapter(registry, configDir)` using existing canonical-runtime
ownership records. Each request revalidates
the registered project. The resolver supplies the existing project's canonical
runtime directory and runtime project ID; callers cannot request filenames.

History returns a sorted recent window of at most 100 run summaries. Detail
currently projects the same safe run identity, status and timestamps; it never
uploads raw run records, prompts, errors, workflow text or credentials. The
adapter reads only records whose project and run identities match. Missing
runtime/history directories and missing logs return explicit unavailable results.
History scans retained records to select this window; buffers use each record's
measured size plus one growth-detection byte, rather than the full log chunk cap.
Scan time still grows with retained run count; this adapter does not add retention
or an index.

Fixed `worker`, `events` and `orchestrator` streams return at most 256 KiB of
UTF-8 text. Signed cursors bind the local project/run/stream, opaque file
generation and byte offset. Replacement, observed truncation or changed cursor
anchor resets to the beginning with `reset: true`. Invalid/foreign cursors are
unavailable; malformed UTF-8 is replaced once across successive chunks. Callers
restart with no cursor after an adapter restart. Symlinked
files and intermediate directories are rejected. Raw log text may contain
sensitive content and belongs only inside the trusted operator access boundary.
No read acquires the lifecycle command slot or persists/uploads logs continuously.

Verification: `pnpm --filter @gh-symphony/management-agent test` covers typed
protocol requests against independent real filesystem fixtures, including
UTF-8/invalid-byte boundaries and cursor replay. CLI tests persist a typed
`OrchestratorRunRecord` through the actual state store before reading it through
the canonical alias resolver. [TC-28](../../e2e/scenarios/28-bounded-local-reads.md)
exercises the bundled factory with a real CLI daemon and five fault probes.
CP-12/15 and applicable U04/U07 reads are owned here; offline transport, read-lane
scheduling, UI follow/disconnect and server retention are separate slices.

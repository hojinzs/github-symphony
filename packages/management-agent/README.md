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

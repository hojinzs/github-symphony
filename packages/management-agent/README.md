# Local management agent

`@gh-symphony/management-agent` is an internal repository-local management
extension (C03, #1007; Epic #983). It is separate from the shipped per-project
`@gh-symphony/control-plane` server and does not schedule or provision projects.

The first implementation slice provides `AgentRegistry.open(dataDirectory)`:

- The directory is canonicalized and restricted to mode `0700`. One agent owns
  its configuration using the existing process-identity/heartbeat lock contract.
  Call `close()` during shutdown; a live owner rejects a second instance.
- `saveIdentity(httpsOrigin, enrollment)` persists an enrollment response in a
  mode `0600` atomic, synced registry file. Retry preserves the enrolled identity
  and allowlist; replacing a different environment, agent or server is rejected.
- `add(folder)` registers an existing directory, including folders without a
  valid workflow or a previous runtime. Realpath aliases collapse to one entry.
  Local IDs use the existing CLI folder-derived algorithm on the canonical path.
- `resolveManaged(localProjectId)` rechecks both the registered path and its
  canonical folder. A moved folder or retargeted symlink requires local
  re-registration. `remove(localProjectId)` removes management access only.
- `inventory(reader, cliVersion)` projects explicit metadata through a typed
  local reader; credentials and arbitrary reader fields are not uploaded. Invalid
  folders remain visible. The fleet server supplies the global project UUID and
  qualifies local IDs by environment; this package does not invent global IDs.

The CLI lifecycle reader/effect adapter and expected-target stop integration are
not present in this initial slice. There is no new `gh-symphony agent` command
surface yet. Outbound transport, durable command journaling, and native service
packaging are separate delivery boundaries in the approved design.

The registry rejects malformed or broadly readable persisted files rather than
silently discarding an enrolled identity. Keep the data directory on a local
user-owned filesystem and treat registry backups as credentials. No management
credential environment variable is introduced.

Run `pnpm --filter @gh-symphony/management-agent test` for filesystem, symlink,
identity, lock and independent protocol-schema contract tests.

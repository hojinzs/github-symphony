# Fleet Control Plane services

Internal repository extension for #1008 (C04, Epic #983), separate from the
per-project `@gh-symphony/control-plane` HTTP server. Requires Node.js 24 on
Linux/macOS. No fleet command or listener is installed by this package.

## Configuration and storage foundation

`resolveFleetConfig({ dataDir, publicOrigin, bindAddress? })` validates an absolute
data directory and an HTTPS UI origin. The default bind address is `127.0.0.1`;
remote private-network binding requires an explicit address. The consuming
server owns TLS or a trusted HTTPS reverse proxy.

`openFleetStore(dataDir)` opens `fleet.sqlite`, enables foreign keys and a bounded
busy timeout, and transactionally applies versioned migrations. New directories
and the database have modes 0700 and 0600. Existing paths must be owned by the
service's Unix user with those modes; symlinks, hardlinked files and unsafe
sidecars are rejected. Paths must use canonical parents (for example resolve
macOS `/var` before using a temporary directory). Do not store fleet state in
project folders or use a shared filesystem.

Close the store when the service stops. Back up after closing it or use a
SQLite-consistent snapshot; do not copy only an active database while ignoring
its journal. Backup metadata includes credential verifiers, never recoverable
remote workspaces.

The initial schema reserves environment, enrollment-verifier, credential-verifier
and audit tables. Enrollment/security services and HTTP integration are still
pending in this delivery's later slices; schema presence is not acceptance
evidence for CP-11/16/20.

## Verification

`pnpm --filter @gh-symphony/fleet-control-plane test` exercises real SQLite files,
private modes and ownership, unsafe paths, reopen durability, migration rollback
and future-schema rejection. See the
[C04 implementation plan](../../docs/designs/2026-10-06-fleet-control-plane-c04-plan.md)
for the remaining contract and black-box cases. These tests validate the host
filesystem, not native service isolation or another operating system.

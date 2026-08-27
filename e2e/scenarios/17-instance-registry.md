# Instance Registry

Validate the host-level instance registry through the packaged CLI.

1. Start a repository orchestrator daemon and verify `gh-symphony instances --json` reports its project, runtime root, PID, uptime, phase, and endpoint when configured.
2. Start the same project again and verify the second daemon exits before a `daemon.pid` file replaces the first daemon's PID record.
3. Remove the runtime lock while preserving its registry entry, then verify `gh-symphony instances` reports `stale-registry` on repeated calls.

# Registry-Free Project Lifecycle

Validate the packaged CLI project lifecycle without a host-global instance registry.

1. Start a standalone project daemon and verify its project-scoped `daemon.pid` record is written only after the project lock is acquired.
2. Run `project status` from the project folder and verify it reports the live daemon through the PID record and project lock.
3. Run `project stop` and verify the daemon exits, the PID record is removed, and the project lock is released.
4. Verify the lifecycle creates no host-global `instances/` directory and that the removed `instances` command is absent from CLI help.

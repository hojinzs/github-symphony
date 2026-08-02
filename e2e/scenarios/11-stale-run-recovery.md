# TC-11: Stale-run ownership and lifecycle recovery

## Setup

```bash
pnpm install --frozen-lockfile
pnpm build
```

The focused service and lifecycle tests cover the fault injections that cannot
be introduced safely through the public dashboard API:

```bash
pnpm exec vitest run packages/orchestrator/src/service.test.ts packages/orchestrator/src/lock.test.ts
pnpm exec vitest run packages/cli/src/commands/lifecycle.test.ts packages/cli/src/config.test.ts packages/cli/src/commands/start.test.ts
```

## Steps

1. Verify a due stale retry fences the issue to its replacement run before the
   worker is spawned, and terminalizes duplicate runs as
   `worker_lease_lost: run_not_current`.
2. Verify clean-workspace convergence returns the tracker item to the first
   configured active state after confirmed readback; when the tracker cannot
   perform that transition, verify a durable failure retry is queued.
3. Verify a persisted worker PID with a different process-start identity is
   rejected before active-run/concurrency accounting.
4. Verify `repo stop` rejects a daemon with the wrong repository CWD and, when
   `daemon.pid` is stale, finds and stops the identity/CWD-matching daemon from
   the project lock.
5. Run the Docker black-box failure/retry lifecycle:

   ```bash
   ./e2e/run-e2e.sh fail 45
   ```

6. In the Docker output, confirm the worker reaches `running`, exits as
   `failed`, enters a retry, releases after fixture removal, and finishes with
   zero active runs.

## Expected

- Exactly one current run owns each issue before worker spawn.
- Superseded workers become terminal and do not consume concurrency.
- Clean convergence is explicit and retryable; it does not remain falsely
  completed or silently locked in the current tracker state.
- Reused/dead worker PIDs are excluded from active status after reconciliation.
- Daemon stopping is bound to the expected repository CWD and reports a clear
  unresolved-daemon error if neither `daemon.pid` nor the project lock identifies
  a matching live process.
- Docker black-box output ends in `PASSED` with a visible failure retry and idle
  final health.

## Cleanup

`e2e/run-e2e.sh` performs cleanup automatically. For interrupted runs:

```bash
docker compose -f docker-compose.e2e.yml down
git restore e2e/fixtures/issues.json
```

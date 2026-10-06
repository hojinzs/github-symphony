# TC-25: Durable publication boundaries

## Purpose

Confirm that optional publication callbacks preserve local persistence and
coordination behavior, and that normal CLI dispatch completes with default
no-op publication. No Collector or exporter is activated in this slice.

## Run

```bash
pnpm --filter @gh-symphony/orchestrator exec vitest run \
  src/publication.test.ts src/service.test.ts \
  -t 'OT-04/12|OT-07|provenance from|failed status commit|stale recovered inventory|without awaiting pending'
./e2e/run-standalone-project-e2e.sh
```

## Expected

- Unit fault injection proves event offers follow durable primary append and
  mirror attempt, preserving bytes/integrity and append-owner IDs. Primary
  failure offers nothing; mirror failure still offers once.
- Unit fault injection proves committed snapshot sequence identity, failed
  commit suppression, throwing/rejected callback containment, tick timing and
  provenance retention. Status reads do not publish or advance counters.
- Docker runs two folder-addressed projects through the built CLI and stub
  worker. Both workers complete, their assigned branches and workspace state
  remain correct, and the runner prints `standalone-project Docker E2E passed`.
  This confirms the default no-op path; callback faults use unit injection.
- An unattended worker may record the narrow preflight status-69 exception
  documented in `AGENT_TEST.md`. Every failure after preflight is a test failure.

## Cleanup

The standalone runner removes its isolated Compose project and image on exit.
Production activation and actual Collector receipt remain separate Epic gates.

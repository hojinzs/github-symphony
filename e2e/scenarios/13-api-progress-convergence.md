# API-side lifecycle progress at convergence

This black-box scenario verifies the orchestrator API half of issue #576. The
stub worker changes an issue from `Ready` to `Done`, confirms the canonical
state readback, and exits successfully without changing the repository
workspace.

```bash
STUB_SCENARIO=api-progress docker compose \
  -f docker-compose.e2e.yml \
  -f docker-compose.e2e.events.yml \
  up -d --build
```

Inject the happy-path fixture and trigger refresh as described in
`AGENT_TEST.md`. Then verify:

1. The worker log contains `api-progress readback` with `"state":"Done"`.
2. The exact run ID observed during dispatch resolves to one persisted
   `run.json` with `status: "succeeded"` and `runPhase: "succeeded"`.
3. Exactly one scenario `run.json` exists, so the original run is neither
   rewritten to `suppressed` / `canceled_by_reconciliation` nor masked by a
   replacement run.

The real worker threshold branch is covered separately by
`packages/worker/src/convergence-lifecycle.test.ts`; the Docker environment
uses the stub worker and therefore validates orchestration/API persistence,
not the Codex multi-turn loop itself.

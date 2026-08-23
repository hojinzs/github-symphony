# Planning phase prompt policy

This black-box scenario verifies issue #614. The seeded workflow configures
`planning_states` with whitespace and case that differ from the fixture's
`Ready` state, then renders `execution_phase` into the dispatched prompt.

```bash
STUB_SCENARIO=prompt-phase docker compose \
  -f docker-compose.e2e.yml \
  -f docker-compose.e2e.events.yml \
  up -d --build
```

Inject `e2e/fixtures/happy-path.json` and trigger refresh as described in
`AGENT_TEST.md`. Verify the stub confirms `Ready → Done` and the run completes
successfully. The `prompt-phase` stub exits with an error unless
`SYMPHONY_RENDERED_PROMPT` contains `phase=planning`, proving the normalized
planning classification reached the worker prompt rather than remaining run
metadata only.

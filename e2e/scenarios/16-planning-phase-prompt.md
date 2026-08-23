# Planning phase prompt policy

This black-box scenario verifies issue #614. The seeded workflow configures
`planning_states` with whitespace and case that differ from the fixture's
`Ready` state, then renders `execution_phase` into the dispatched prompt.

```bash
./e2e/run-e2e.sh prompt-phase
```

The runner asserts the fixture reaches `Done` and the persisted run succeeds.
The `prompt-phase` stub exits with an error unless
`SYMPHONY_RENDERED_PROMPT` contains `phase=planning`, proving the normalized
planning classification reached the worker prompt rather than remaining run
metadata only.

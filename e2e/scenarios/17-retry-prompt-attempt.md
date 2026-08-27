# Retry prompt attempt rendering

This black-box scenario verifies issue #654. The first worker completion keeps
the issue actionable, so the orchestrator schedules a continuation. The second
worker exits with an error unless its rendered prompt contains
`retry_attempt=1`, then confirms the issue is `Done` to stop the retry loop.

```bash
GH_SYMPHONY_HTTP_TOKEN=e2e-http-token ./e2e/run-e2e.sh retry-attempt 45
```

The runner requires the retried worker to reach a successful terminal state;
the stub's prompt assertion proves the persisted continuation attempt reached
the worker environment rather than remaining in retry metadata.

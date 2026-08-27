# TC-17: Retry Fire Refresh Safety

## Scope

The retry-fire semantics are covered with deterministic orchestrator tests because
the Docker file tracker cannot emulate GitHub Project's server-side terminal
candidate filtering. The Docker black-box run confirms the deployed retry
lifecycle remains healthy.

## Automated checks

```bash
pnpm --filter @gh-symphony/orchestrator exec vitest run src/service.test.ts \
  -t 'requeues an active retry|cleans up and releases a terminal retry|releases due retrying runs when the tracker issue is missing|requeues due retries when the single-ID refresh fails'
bash e2e/run-e2e.sh happy 60
```

## Expected

- A due retry refreshes only its canonical ID.
- A missing or non-routable item releases its claim without dispatch.
- A terminal item cleans its workspace even when it is absent from the regular
  candidate list.
- Refresh failure and exhausted concurrency retain the retry reservation and
  schedule a later attempt with the reported error.
- The Docker runtime still dispatches, reports a retry, and returns to idle.

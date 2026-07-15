# TC-10: HTTP localhost default, bearer gate, and state redaction

## Setup

```bash
export GH_SYMPHONY_HTTP_TOKEN=e2e-http-token
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml up -d --build
curl --fail --retry-all-errors --retry 20 --retry-delay 2 \
  http://localhost:4680/healthz
```

The Docker entrypoint uses `--bind-all` because publishing a container port is
an explicit all-interface opt-in. Unit tests cover the production default
`127.0.0.1` binding without that flag.

## Steps

1. Verify an unauthenticated state request is rejected:

   ```bash
   test "$(curl -s -o /tmp/state-unauth.json -w '%{http_code}' \
     http://localhost:4680/api/v1/state)" = "401"
   ```

2. Verify an unauthenticated refresh is rejected:

   ```bash
   test "$(curl -s -o /tmp/refresh-unauth.json -w '%{http_code}' \
     -X POST http://localhost:4680/api/v1/refresh)" = "401"
   ```

3. Authenticate, inject an issue, and trigger reconciliation:

   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   test "$(curl -s -o /tmp/refresh-auth.json -w '%{http_code}' \
     -H 'Authorization: Bearer e2e-http-token' \
     -X POST http://localhost:4680/api/v1/refresh)" = "202"
   ```

4. Poll authenticated state and verify sensitive fields are redacted:

   ```bash
   state="$(curl -s -H 'Authorization: Bearer e2e-http-token' \
     http://localhost:4680/api/v1/state)"
   jq -e '.. | objects | select(has("runId")) | .runId == "[REDACTED]"' \
     <<<"$state"
   jq -e '.. | objects | select(has("issueIdentifier")) | \
     .issueIdentifier == "[REDACTED]"' <<<"$state"
   test "$(jq -r '.lastError // "null"' <<<"$state")" != \
     "private project failure"
   ```

## Expected

- `/healthz` remains available for liveness checks.
- Every `/api/v1/*` route rejects missing bearer credentials with `401`.
- Authenticated refresh returns `202` and dispatch becomes observable.
- State preserves operational status while redacting issue/run identity,
  token usage, workspace/session paths, and error details.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
rm -f /tmp/state-unauth.json /tmp/refresh-unauth.json /tmp/refresh-auth.json
```

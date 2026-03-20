# TC-08: Evidence Mirror Permission Cleanup

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
mkdir -p evidence
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build
curl --fail --retry-all-errors --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. Inject the happy-path fixture and trigger reconciliation.
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   curl -s -X POST http://localhost:4680/api/v1/refresh
   ```

2. Wait until `evidence/projects/e2e-project/runs/*/events.ndjson` is created on the host.
   ```bash
   find evidence -name events.ndjson -print
   ```

3. Verify the mirrored artifact is owned by the host user instead of `root`.
   ```bash
   stat -c '%U:%G %a %n' evidence/projects/e2e-project/runs/*/events.ndjson
   ```

4. Run the standard E2E cleanup and confirm the evidence directory can be deleted without `Permission denied`.
   ```bash
   ./e2e/run-e2e.sh happy 40
   rm -rf evidence
   ```

## Expected

- Mirrored `events.ndjson` is created under `./evidence/`.
- The host can remove `./evidence/` without `sudo` or `Permission denied`.
- The E2E runner cleanup does not leave root-owned artifacts behind.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml down
echo "[]" > e2e/fixtures/issues.json
rm -rf evidence
```

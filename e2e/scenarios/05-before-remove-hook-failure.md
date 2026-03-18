# TC-05: `before_remove` Hook Failure Does Not Block Cleanup

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml up -d --build
curl --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. Seed a failing `before_remove` hook into the E2E repository.
   ```bash
   docker exec symphony-e2e sh -lc '
     cd /e2e/repos/test-owner/test-repo &&
     mkdir -p hooks &&
     cat > hooks/before_remove.sh <<'"'"'EOF'"'"'
#!/usr/bin/env bash
set -eu
printf "cleanup hook failed" >&2
exit 1
EOF
     chmod +x hooks/before_remove.sh &&
     awk '
       !inserted && /^polling:$/ {
         print "hooks:"
         print "  before_remove: hooks/before_remove.sh"
         inserted = 1
       }
       { print }
     ' WORKFLOW.md > WORKFLOW.md.tmp &&
     mv WORKFLOW.md.tmp WORKFLOW.md &&
     git add WORKFLOW.md hooks/before_remove.sh &&
     git commit -m "Add failing before_remove hook for E2E"
   '
   ```

2. Inject an active issue and trigger reconciliation.
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   curl -X POST http://localhost:4680/api/v1/refresh
   ```

3. Wait until the issue workspace is created.
   ```bash
   docker exec symphony-e2e sh -lc '
      for i in $(seq 1 20); do
        find /app/.runtime/projects -name workspace.json | grep -q . && exit 0
       sleep 1
     done
     exit 1
   '
   ```

4. Mark the same issue as terminal and trigger reconciliation again.
   ```bash
   cat > e2e/fixtures/issues.json <<'EOF'
   [{
     "id": "issue-happy-1",
     "identifier": "test-owner/test-repo#1",
     "number": 1,
     "title": "Happy path test issue",
     "description": "This issue should be dispatched and completed successfully.",
     "priority": null,
     "state": "Done",
     "branchName": null,
     "url": null,
     "labels": [],
     "blockedBy": [],
     "createdAt": "2026-03-17T00:00:00Z",
     "updatedAt": "2026-03-17T00:00:00Z",
     "repository": {
       "owner": "test-owner",
       "name": "test-repo",
       "cloneUrl": "/e2e/repos/test-owner/test-repo"
     },
     "tracker": {
       "adapter": "file",
       "bindingId": "e2e-test",
       "itemId": "issue-happy-1"
     },
     "metadata": {}
   }]
   EOF
   curl -X POST http://localhost:4680/api/v1/refresh
   ```

5. Poll until cleanup finishes, then inspect the workspace record and logs.
   ```bash
   docker exec symphony-e2e sh -lc '
      for i in $(seq 1 20); do
        record=$(find /app/.runtime/projects -name workspace.json | head -n 1)
       [ -n "$record" ] || { sleep 1; continue; }
       python3 - "$record" <<'"'"'PY'"'"'
import json, sys
with open(sys.argv[1]) as fh:
    data = json.load(fh)
print(data["status"])
sys.exit(0 if data["status"] == "removed" else 1)
PY
       [ $? -eq 0 ] && exit 0
       sleep 1
     done
     exit 1
   '
   docker logs symphony-e2e 2>&1 | grep 'before_remove hook failed'
   ```

## Expected

- `before_remove` hook exits non-zero, but cleanup continues.
- Workspace record transitions to `removed`.
- No `cleanup_blocked` transition appears.
- Orchestrator logs a warning containing `continuing cleanup`.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```

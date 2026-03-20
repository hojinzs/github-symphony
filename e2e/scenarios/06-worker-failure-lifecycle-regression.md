# TC-06: Worker Failure Lifecycle Regression

## Setup

```bash
./e2e/run-e2e.sh fail 30
```

## Steps

1. `fail` 시나리오로 E2E 환경을 기동한다.
2. `happy-path` fixture를 주입하고 reconciliation을 트리거한다.

```bash
# happy-path fixture 주입
cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json

# orchestrator에 refresh 요청을 보내 reconciliation 트리거
ORCH_URL="${ORCH_URL:-http://localhost:8080}"
curl -X POST "${ORCH_URL}/api/v1/refresh"
```

3. worker가 `starting`에서 `running`으로 진입한 뒤 실패하는지 관찰한다.
4. orchestrator가 retry를 스케줄링하고, issue 제거 후 `idle`로 복귀하는지 확인한다.

```bash
# worker / orchestrator 상태를 폴링하여 상태 전이를 관찰
watch -n 2 curl -s "${ORCH_URL:-http://localhost:8080}/api/v1/status"
```

## Expected

- worker failure 이후 orchestrator가 run failure를 감지한다.
- retry queue에 continuation 또는 failure retry가 기록된다.
- cleanup 후 상태가 `idle`로 복귀한다.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```

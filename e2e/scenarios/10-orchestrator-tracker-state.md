# TC-10: Run-scoped orchestrator tracker state API

## Setup

1. `echo "[]" > e2e/fixtures/issues.json`
2. `mkdir -p evidence`
3. `docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build`
4. `/healthz`가 성공할 때까지 대기한다.

## Steps

1. `e2e/fixtures/happy-path.json`을 `e2e/fixtures/issues.json`에 복사한다.
2. `POST /api/v1/refresh`를 호출하고 active run의 `runId`를 조회한다.
3. run ID 없이 `POST /api/v1/tracker-state`에 `{"type":"state-read"}`를 보내 완전한 `TrackerStateResult` shape의 `400`을 확인한다.
4. 현재 run ID만 사용하고 worker에 주입된 `SYMPHONY_ORCHESTRATOR_TOKEN`을 생략해 `401`, `tracker_state_authentication_failed`를 확인한다.
5. worker 프로세스 환경에서 token을 읽고 `X-Symphony-Orchestrator-Token`으로 전달하되, `X-Symphony-Run-Id`에 존재하지 않는 run을 넣어 `403`, `run_not_found`를 확인한다.
6. 현재 run ID와 token으로 요청해 file tracker가 provider transition을 지원하지 않음을 나타내는 `403`, `tracker_state_requests_unsupported`를 확인한다.
7. `events.ndjson`에서 인증을 통과한 현재 run 요청의 `tracker.state` durable rejection event를 확인한다.
8. GitHub adapter unit integration TC에서 다섯 transition을 동시에 보내 각 요청이 canonical item ID만 조회하고 provider 호출 최대 동시성이 1인지 확인한다.

## Expected

- HTTP API가 process-secret 인증을 통과하고 `SYMPHONY_RUN_ID`에 해당하는 current run만 승인한다.
- 상태 API에 노출된 run ID만으로는 tracker read/mutation을 호출할 수 없다.
- 지원되지 않거나 stale한 요청은 성공으로 오인되지 않고 진단 가능한 결과/event를 남긴다.
- worker 실패 경로에서 lifecycle comment/workpad를 허용하는 confirmed 응답이 반환되지 않는다.
- GitHub adapter 동시성 TC는 board-wide item query 없이 exact-item read → mutation → exact-item readback만 수행한다.

## Cleanup

1. `echo "[]" > e2e/fixtures/issues.json`
2. `docker compose -f docker-compose.e2e.yml down`
3. `rm -rf evidence`

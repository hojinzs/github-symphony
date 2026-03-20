## 리뷰 요약: 병합 보류를 권장합니다

이 PR은 하드코딩된 retry attempt cap (3회)을 제거하여 failure retry를 무제한으로 허용합니다. spec §8.4의 취지는 이해하지만, **대체 안전장치 없이 cap만 제거하는 것은 프로덕션 위험이 큽니다.**

### 주요 위험

**1. 무한 워커 루프 (Zombie Retry Loop)**

`reconcileRun`에서 워커 종료 시 `classifyRetryKind`가 `failure`를 반환해도 retry는 무조건 스케줄됩니다. 트래커 이슈가 삭제되거나 비정상 상태가 되면 stale metadata로부터 영원히 워커를 재생성합니다. Codex 리뷰어의 P1 지적과 동일한 우려입니다.

**2. 리소스 고갈**

- backoff ceiling이 `DEFAULT_MAX_DELAY_MS = 300,000ms` (5분)이므로, 실패하는 이슈 하나가 **5분마다 영원히** 워커를 스폰합니다
- 여러 이슈가 동시에 실패하면 concurrency 슬롯을 점유하여 정상 이슈 처리를 차단합니다

**3. 안전장치 부재**

기존 3회 cap은 crude하지만 circuit breaker 역할을 했습니다. 제거 후 대체 메커니즘이 전혀 추가되지 않았으며, spec §8.4의 "workflow backoff policy"를 따른다고 하지만 실제로 `maxAttempts` 같은 설정을 workflow config에서 읽는 로직이 없습니다.

### 권장 사항

하드코딩 cap 제거 자체는 합리적이지만, 다음이 **동시에** 구현되어야 합니다:

1. **Workflow config에서 `maxAttempts` 설정** — `WORKFLOW.md`에서 configurable하게
2. **Tracker eligibility check** — retry 전에 이슈가 여전히 존재하고 actionable한지 확인
3. **합리적인 기본 상한선** — config 미설정 시 기본값 (예: 10~20회)
4. **경고 로깅** — 일정 횟수 초과 시 warning 로그 출력

### 추가: 테스트 관련 지적사항

- `service.test.ts`: `fetchImpl`이 `/api/v1/state` 요청에도 `createEmptyTrackerResponse()`를 반환하여 `fetchLiveWorkerState` 파싱 regression을 숨길 수 있습니다 (Copilot 리뷰 동의)
- `06-unbounded-failure-retry.md`: `docker-compose.e2e.yml`에 `STUB_SCENARIO: happy`가 하드코딩되어 있어 `STUB_SCENARIO=fail` prefix가 동작하지 않습니다 (Copilot 리뷰 동의)

# AGENT_TEST.md

AI Agent가 코드 변경 후 Docker 격리 환경에서 E2E 블랙박스 테스트를 수행하기 위한 가이드.

## 테스트 계층

| 계층 | 도구 | 실행 시점 |
|---|---|---|
| Unit Test | `pnpm test` (Vitest) | 코드 변경 직후 |
| Type Check | `pnpm typecheck` | 코드 변경 직후 |
| Lint | `pnpm lint` | 코드 변경 직후 |
| **E2E Test** | Docker + CLI | 통합 동작 검증이 필요할 때 |

## 필수 검증 (모든 코드 변경 후)

```bash
pnpm lint && pnpm test && pnpm typecheck && pnpm build
```

이 네 가지가 모두 통과해야 작업 완료로 간주한다.

## E2E 테스트 환경

### 아키텍처

```
AI Agent
    │
    │ docker compose -f docker-compose.e2e.yml up -d
    │ curl http://localhost:4680/api/v1/status
    │ docker logs symphony-e2e
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Docker Container (symphony-e2e)                  │
│                                                   │
│  Orchestrator ──spawn──→ Stub Worker              │
│       │                   (Codex 대체)            │
│       │                   /api/v1/state           │
│  File Tracker                                     │
│  (/e2e/fixtures/issues.json)                      │
│                                                   │
│  .runtime/ (tmpfs, 컨테이너 종료 시 소멸)         │
│  /e2e/repos/ (pre-seeded local git repo)          │
│                                                   │
│  :4680 status API (외부 노출)                     │
└──────────────────────────────────────────────────┘
```

- **File Tracker** (`@gh-symphony/tracker-file`): GitHub API 없이 JSON 파일에서 이슈를 읽음
- **Stub Worker** (`e2e/stub-worker.ts`): Codex AI 없이 Worker 동작을 시뮬레이션
- **격리**: 모든 상태는 tmpfs에 저장되어 컨테이너 종료 시 소멸. 로컬 `.runtime/`에 아무 영향 없음
- **이벤트 미러링(선택)**: `docker-compose.e2e.events.yml` override를 함께 쓰면 `events.ndjson`이 호스트 `./evidence/`에도 복제됨

### Stub Worker 시나리오

`STUB_SCENARIO` 환경변수로 worker 동작을 제어:

| Scenario | 동작 |
|---|---|
| `happy` (기본) | starting(2s) → running(5s) → completed, exit 0 |
| `fail` | starting(2s) → running(3s) → failed, exit 1 |
| `stall` | starting(2s) → running(무한), SIGTERM 대기 |
| `slow` | starting(2s) → running(30s) → completed, exit 0 |

`docker-compose.e2e.yml`는 `environment.STUB_SCENARIO: ${STUB_SCENARIO:-happy}`를 사용하므로, 쉘 환경변수로 시나리오를 선택할 수 있다.

```bash
STUB_SCENARIO=fail docker compose -f docker-compose.e2e.yml up -d --build
```

## E2E 테스트 실행 방법

### 1. 환경 기동

```bash
echo "[]" > e2e/fixtures/issues.json
mkdir -p evidence
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build
curl --fail --retry-all-errors --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

### 2. 이슈 주입

```bash
# 사전 정의된 fixture 사용
cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json

# 또는 직접 작성
cat > e2e/fixtures/issues.json << 'EOF'
[{
  "id": "issue-1",
  "identifier": "test-owner/test-repo#1",
  "number": 1,
  "title": "Test issue",
  "description": null,
  "priority": null,
  "state": "Ready",
  "branchName": null,
  "url": null,
  "labels": [],
  "blockedBy": [],
  "createdAt": null,
  "updatedAt": null,
  "repository": {
    "owner": "test-owner",
    "name": "test-repo",
    "cloneUrl": "/e2e/repos/test-owner/test-repo"
  },
  "tracker": {
    "adapter": "file",
    "bindingId": "e2e-test",
    "itemId": "issue-1"
  },
  "metadata": {}
}]
EOF
```

### 3. Reconciliation 트리거

```bash
curl -X POST http://localhost:4680/api/v1/refresh
```

### 4. 상태 관찰

```bash
# 프로젝트 전체 상태
curl -s http://localhost:4680/api/v1/status | jq .

# 핵심 필드만
curl -s http://localhost:4680/api/v1/status | jq '{
  health,
  activeRuns: .summary.activeRuns,
  runs: [.activeRuns[] | {status, executionPhase, lastEvent, retryKind}],
  retryQueue: [.retryQueue[] | {retryKind, nextRetryAt}],
  lastError
}'
```

### 5. 이슈 제거 (retry 중단)

```bash
echo "[]" > e2e/fixtures/issues.json
```

Stub worker는 이슈 상태를 변경하지 않으므로, 완료 후 이슈를 제거해야 retry 루프가 멈춘다.

### 6. 로그 확인

```bash
# Orchestrator 로그
docker logs symphony-e2e

# 이벤트 로그 (구조화된 NDJSON, 기본 tmpfs)
docker exec symphony-e2e sh -c 'cat /app/.runtime/projects/e2e-project/runs/*/events.ndjson'

# 호스트 미러 로그 (events override 활성화 시)
tail -f evidence/projects/e2e-project/runs/*/events.ndjson

# Worker 로그 (stderr만 캡처됨)
docker exec symphony-e2e sh -c 'cat /app/.runtime/projects/e2e-project/runs/*/worker.log'
```

### 7. 정리

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
rm -rf evidence
```

## 핵심 동작 이해

### Worker Lifecycle in E2E

```
idle → [inject issue + refresh]
     → dispatching (git clone ~3-5s)
     → running (stub worker ~7s for happy scenario)
     → retrying/continuation (issue still in active state)
     → [remove issue]
     → retrying/failure
     → [due retry + tracker recheck confirms issue missing/non-actionable]
     → released
     → idle
```

- Orchestrator는 worker가 exit하면 이슈 상태를 확인하여 retry 종류를 결정
  - 이슈가 여전히 active state → `continuation` retry
  - 이슈가 없거나 terminal state → `failure` retry
- Stub worker는 이슈 상태를 변경하지 않으므로, 이 동작이 정상임

### 사전 정의된 Fixture

| 파일 | 용도 |
|---|---|
| `e2e/fixtures/happy-path.json` | 단일 이슈 (state: Ready) |
| `e2e/fixtures/multi-issue.json` | 3개 이슈 (동시성 테스트, concurrency_limit=2) |
| `e2e/fixtures/blocked-issue.json` | blockedBy가 있는 이슈 |

### 사전 정의된 시나리오 문서

| 파일 | 시나리오 |
|---|---|
| `e2e/scenarios/01-happy-path.md` | 이슈 dispatch → worker 완료 → lifecycle 관찰 |
| `e2e/scenarios/02-multi-issue.md` | 동시성 제한 확인 |
| `e2e/scenarios/03-stall-detection.md` | stall → SIGTERM → retry |
| `e2e/scenarios/04-fail-retry.md` | 실패 → 재시도 스케줄링 |
| `e2e/scenarios/08-evidence-permissions.md` | 이벤트 미러 evidence 파일 권한 및 cleanup 검증 |

## TC 작성 가이드

E2E 테스트 케이스는 다음 구조를 따른다:

```markdown
# TC-XX: 제목

## Setup
컨테이너 기동, fixture 준비

## Steps
1. 이슈 주입
2. refresh 트리거
3. 상태 폴링 (기대값 포함)
4. 추가 조작 (이슈 제거 등)

## Expected
기대하는 동작과 상태 전이

## Cleanup
컨테이너 중지, fixture 초기화
```

### TC 작성 시 주의사항

- **타이밍**: workspace 준비(git clone)에 3-5초, worker 실행에 시나리오별 시간이 필요함
- **폴링 간격**: 1초 간격으로 상태를 폴링하되, 최대 대기 시간을 설정
- **이슈 제거**: worker 완료 관찰 후 반드시 이슈를 제거해야 retry 루프 방지
- **STUB_SCENARIO**: 시나리오에 맞는 worker 동작을 선택 (예: `STUB_SCENARIO=fail docker compose ...`)

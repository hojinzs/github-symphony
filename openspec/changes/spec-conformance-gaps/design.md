## Context

Symphony spec (docs/symphony-spec.md)은 dispatch 정렬, multi-turn worker, 세션 타임아웃, 토큰 accounting 등을 정의하고 있으나, 현 구현체(github-symphony)는 이 중 상당수를 생략하고 있다. 구현체는 Linear 대신 GitHub Projects를 tracker로 사용하며, workspace 관리, 폴링, retry 등 핵심 루프는 잘 동작하지만, spec conformance 세부사항에서 갭이 있다.

현재 코드 구조:
- `packages/orchestrator/src/service.ts` — 메인 오케스트레이터 (dispatch, reconciliation)
- `packages/worker/src/index.ts` — worker 프로세스 (codex 세션 관리)
- `packages/runtime-codex/src/runtime.ts` — codex 런타임 설정
- `packages/core/src/workflow/render.ts` — 프롬프트 렌더링
- `packages/core/src/contracts/status-surface.ts` — 상태 스냅샷 타입
- `packages/core/src/observability/structured-events.ts` — 구조화 이벤트

## Goals / Non-Goals

**Goals:**
- Dispatch 후보 정렬을 spec 대로 구현 (priority → created_at → identifier)
- Per-state 동시성 제한과 Todo blocker 규칙 추가
- Worker 내 multi-turn 실행 루프 구현
- 에이전트 세션에 read/turn 타임아웃 적용
- user_input_required 이벤트에 대한 hard failure 핸들러 추가
- 프롬프트 템플릿 strict 모드 도입
- 토큰 accounting 및 rate-limit 추적
- `POST /api/v1/refresh` 엔드포인트 추가

**Non-Goals:**
- Workspace key 정규화 방식 변경 (SHA-256 해시 유지)
- `~` 홈 경로 확장 구현
- `created_now` 명시적 플래그 추가
- Legacy sectioned workflow 포맷 제거
- 분산 orchestrator 또는 persistent retry queue

## Decisions

### D1: Dispatch 정렬 위치

**결정**: `packages/orchestrator/src/service.ts`의 `reconcileWorkspace()` 내에서 `actionableCandidates`를 정렬한 후 `unscheduledCandidates`를 추출한다.

**대안 A** (채택): Orchestrator에서 in-memory 정렬. TrackedIssue에 이미 priority, createdAt 필드가 있으므로 추가 데이터 없이 가능.

**대안 B**: Tracker adapter 레벨에서 정렬된 결과 반환. 그러나 adapter는 tracker API 추상화이므로 정렬 정책을 넣기에 부적절.

**근거**: 정렬은 orchestration 정책이므로 orchestrator가 소유해야 한다.

### D2: Per-state 동시성 제한 구현

**결정**: `WorkflowDefinition`에 `maxConcurrentByPhase: Record<WorkflowExecutionPhase, number>` 필드를 추가하고, dispatch 시 현재 running 중인 이슈의 phase 분포를 확인한다.

**근거**: Spec의 `max_concurrent_agents_by_state`를 직접 매핑. Phase는 이미 정규화되어 있으므로 state → phase 변환 후 카운팅.

### D3: Todo blocker 규칙

**결정**: `TrackedIssue.blockedBy` 배열을 평가하여 planning phase 이슈에 non-terminal blocker가 있으면 dispatch에서 제외한다.

**현재 상태**: GitHub tracker adapter는 `blockedBy: []`를 항상 반환. 이를 GitHub issue의 "tracked by" 관계에서 파생하도록 adapter를 확장해야 한다.

**대안**: Blocker 정보가 GitHub Projects에서 직접 제공되지 않으므로, 첫 구현에서는 blocker 규칙 프레임워크만 두고 실제 blocker 데이터 수집은 후속 작업으로 분리한다.

**결정**: 프레임워크만 구현. `blockedBy`가 비어있지 않으면 평가하되, GitHub adapter의 blocker 데이터 수집은 별도 change로.

### D4: Multi-turn worker 루프

**결정**: `packages/worker/src/index.ts`에서 turn/completed 수신 후 즉시 exit하는 대신, tracker에서 이슈 상태를 재확인하고 active이면 같은 thread에 continuation turn을 시작하는 루프를 구현한다. `agent.max_turns` (기본값 20)까지 반복.

**핵심 변경점**:
1. turn/completed 핸들러에서 exit 대신 상태 확인 분기
2. Continuation turn은 원래 프롬프트가 아닌 continuation guidance 메시지 전송
3. max_turns 도달 시 정상 종료

**대안**: 현재처럼 1 turn = 1 worker로 유지하고 orchestrator의 continuation retry에 의존. 그러나 이는 매 turn마다 codex 프로세스를 재시작하므로 thread context가 끊기고 비효율적.

### D5: 세션 타임아웃 구현

**결정**: Worker에 두 가지 타임아웃을 추가한다.

1. **read_timeout_ms** (기본 5000ms): `sendRequest()` 함수에서 codex 응답 대기 시 적용. 초기화/thread-start/turn-start 요청에 사용.
2. **turn_timeout_ms** (기본 3600000ms = 1h): turn/start 전송 후 turn/completed 수신까지의 절대 타임아웃. setTimeout으로 구현하고 초과 시 codex 프로세스 종료.

### D6: Strict 템플릿 렌더링

**결정**: `packages/core/src/workflow/render.ts`의 `renderPrompt()`에 `strict: boolean` 옵션을 추가한다. strict=true일 때 미해석 `{{variable}}`이 남아있으면 에러를 throw한다. 기본값은 `true` (spec 준수).

**대안**: 별도의 validate 단계를 두는 방법. 그러나 렌더링과 검증을 분리하면 호출자가 둘 다 호출해야 하므로 단일 함수에 통합.

### D7: 토큰 accounting 아키텍처

**결정**: 3-layer 파이프라인으로 구현.

1. **Worker layer**: codex stdout에서 token usage 이벤트 파싱, orchestrator에 전달 (환경변수 `SYMPHONY_ORCHESTRATOR_URL` 또는 state server의 API 확장)
2. **Orchestrator layer**: per-run 토큰을 집계하여 `OrchestratorRuntimeState`에 `codexTotals` 유지
3. **API layer**: `/api/v1/status` 응답에 `codex_totals`와 `rate_limits` 필드 추가

**현실적 제약**: Worker → Orchestrator 간 실시간 토큰 전달 채널이 현재 없다. Worker의 state server (`/api/v1/state`)를 통해 orchestrator가 폴링하거나, worker exit 시 최종 토큰 합계를 run state 파일에 기록하는 방식을 사용한다.

**결정**: Worker exit 시 run state에 최종 토큰 기록 + orchestrator가 집계. 실시간 추적은 후속 개선.

### D8: `POST /api/v1/refresh` 구현

**결정**: `packages/orchestrator/src/status-server.ts`에 엔드포인트를 추가. 요청 수신 시 즉시 poll tick을 트리거하되, 동시 요청은 coalesce한다. 202 Accepted 응답.

## Risks / Trade-offs

- **[Multi-turn worker 복잡성]** → Turn 루프 내 에러 처리가 복잡해짐. 미티게이션: 모든 실패는 세션 종료 + orchestrator retry로 귀결되도록 fail-fast.
- **[Blocker 데이터 부재]** → GitHub adapter가 blocker 관계를 아직 수집하지 않음. 미티게이션: 프레임워크만 구현하고 빈 배열일 때 규칙이 no-op이 되도록 설계.
- **[토큰 집계 지연]** → Worker exit 시점에만 토큰이 집계되므로 실행 중인 세션의 토큰은 실시간으로 보이지 않음. 미티게이션: Worker state server에서 현재 세션 토큰을 노출하여 dashboard에서 조회 가능.
- **[Strict 렌더링 하위 호환]** → 기존 WORKFLOW.md가 미정의 변수를 사용할 경우 깨질 수 있음. 미티게이션: 기본값 strict=true로 설정하되 config에서 override 가능하게.

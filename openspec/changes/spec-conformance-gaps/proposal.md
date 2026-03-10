## Why

Symphony spec (docs/symphony-spec.md) 대비 구현 충실도 분석 결과, 핵심 동작에 영향을 미치는 미구현 항목들이 확인되었다. Dispatch 정렬, multi-turn worker, 세션 타임아웃, 토큰 accounting 등이 빠져 있어 spec conformance를 충족하지 못하며, 이는 운영 안정성과 디버깅 가시성에 직접 영향을 준다.

## What Changes

### Dispatch & Scheduling
- Candidate 이슈를 priority(asc) → created_at(oldest) → identifier(lexicographic) 순으로 정렬하여 dispatch
- Per-state 동시성 제한 (`max_concurrent_agents_by_state`) 지원
- Todo 상태 이슈의 blocker 규칙 적용 (non-terminal blocker가 있으면 dispatch 보류)
- `POST /api/v1/refresh` 엔드포인트 추가 (즉시 poll+reconciliation 트리거)

### Worker & Agent Session
- Multi-turn worker: 단일 worker run 내에서 max_turns까지 반복 (turn 완료 → tracker 상태 확인 → active면 continuation turn)
- `read_timeout_ms`: codex stdout 응답 대기 타임아웃
- `turn_timeout_ms`: 단일 turn 절대 타임아웃
- `user_input_required` 이벤트 수신 시 hard failure 처리

### Template & Config
- Strict 템플릿 렌더링: 미정의 변수/필터 사용 시 에러 발생 (현재는 원문 유지)

### Observability
- 토큰 accounting: 에이전트 세션의 input/output/total 토큰 추적 및 집계
- Rate-limit 스냅샷 추적 및 API 노출
- 구조화된 이벤트에 `issue_id`, `session_id` 필드 추가

### Decisions (현행 유지)
- **Workspace key 정규화**: spec은 문자 치환(`[^A-Za-z0-9._-]` → `_`)을 요구하나, 현 구현의 SHA-256 해시 방식이 collision-resistant하고 이미 안전한 hex chars만 사용하므로 **현행 유지**. Spec 적응 문서에 deviation으로 기록.
- **`~` 홈 경로 확장**: 이 구현체는 workspace root를 control-plane DB에서 관리하므로 WORKFLOW.md의 `~` 확장은 불필요. **미구현 유지**.
- **`created_now` 명시적 플래그**: createdAt 존재 여부로 판단 가능하며 hook 트리거가 정상 동작하므로 **현행 유지**.

## Capabilities

### New Capabilities
- `dispatch-priority-and-eligibility`: Dispatch 후보 정렬(priority/created_at/identifier), per-state 동시성 제한, Todo blocker 규칙을 포함하는 후보 선택 정책
- `agent-session-lifecycle`: Multi-turn worker 실행, 세션 타임아웃(read/turn), user_input_required hard failure를 포함하는 에이전트 세션 생명주기 관리
- `token-and-ratelimit-observability`: 토큰 accounting, rate-limit 추적, 구조화된 이벤트 필드 보강을 포함하는 관찰성 확장

### Modified Capabilities
- `cli-orchestrator-service`: `POST /api/v1/refresh` 엔드포인트 추가
- `symphony-core-conformance`: Strict 템플릿 렌더링 요구사항 추가

## Impact

- **packages/orchestrator**: dispatch 로직 변경 (정렬, per-state 제한, blocker), refresh 엔드포인트 추가, 토큰 집계 상태 관리
- **packages/worker**: multi-turn loop, 타임아웃 핸들러, user_input_required 핸들러 추가
- **packages/core**: 템플릿 렌더러 strict 모드, 토큰/rate-limit 도메인 타입 추가, 구조화된 이벤트 스키마 확장
- **packages/runtime-codex**: 토큰 이벤트 파싱 및 upstream 전달
- **API 계약**: `/api/v1/state` 응답에 codex_totals, rate_limits 필드 추가; `/api/v1/refresh` 신규

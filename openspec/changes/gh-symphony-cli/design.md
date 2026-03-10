## Context

현재 Symphony 오케스트레이터를 실행하려면 Control Plane 셋업(PostgreSQL, Next.js), 환경변수 다수 설정, GitHub OAuth App 생성, workspace config 수동 생성 등 복잡한 단계가 필요하다. 이는 팀 환경에선 적절하지만, 개인 개발자나 소규모 팀에게는 진입 장벽이 높다.

기존 `packages/orchestrator`는 이미 Control Plane 없이 독립 실행 가능하지만, workspace config를 직접 JSON으로 작성해야 하고 GitHub Project status-to-phase 매핑을 수동으로 설정해야 한다.

`packages/cli`는 이 과정을 인터랙티브 위저드로 감싸서, GitHub API를 통해 프로젝트/레포 정보를 자동 수집하고, status 컬럼 매핑을 안내하며, 기존 orchestrator 서비스를 래핑하여 실행한다.

## Goals / Non-Goals

**Goals:**
- `npm install -g gh-symphony` → `gh-symphony init` → `gh-symphony start` 3단계로 오케스트레이터 실행
- GitHub Project status 컬럼을 Symphony phase에 인터랙티브하게 매핑
- 컬럼명 패턴 매칭으로 smart defaults 제공 (대부분 Enter만 눌러도 완료)
- `~/.gh-symphony/` 기반 독립 설정 — Control Plane 불필요
- 기존 orchestrator/worker 패키지 코드 변경 최소화

**Non-Goals:**
- Control Plane 대체 — CLI는 개인/소규모용, Control Plane은 팀/엔터프라이즈용으로 공존
- 새로운 오케스트레이션 로직 — CLI는 기존 `OrchestratorService`를 래핑만 함
- GitHub App 인증 — CLI는 PAT 기반만 지원 (App 인증은 Control Plane 영역)
- Worker/Runtime 구현 변경 — 기존 worker와 runtime-codex를 그대로 사용
- 멀티 테넌트 — CLI는 단일 사용자 로컬 실행 전용

## Decisions

### 1. 패키지 구조: `packages/cli`를 monorepo 내 새 패키지로

`packages/cli`를 monorepo에 추가하고 `gh-symphony` bin을 등록한다. orchestrator를 fork하거나 별도 레포로 분리하지 않는다.

- **이유**: monorepo 내에서 `core`, `orchestrator`, `tracker-github` 타입을 직접 import 가능. 빌드/테스트 파이프라인 통합.
- **대안 — 별도 레포**: 배포는 독립적이나 타입 공유가 어렵고 버전 동기화 부담.
- **대안 — orchestrator에 init 명령어 추가**: orchestrator의 관심사(dispatch/reconcile)와 CLI UX(인터랙티브 프롬프트)가 섞임.

### 2. 인터랙티브 프롬프트: `@clack/prompts` 사용

`@clack/prompts`를 터미널 프롬프트 라이브러리로 선택한다.

- **이유**: 경량, 아름다운 UI, TypeScript 네이티브, 취소 처리 내장. spinner/progress 지원.
- **대안 — inquirer**: 기능이 풍부하지만 무겁고 CJS 기반.
- **대안 — prompts (npm)**: 가볍지만 UI가 단조롭고 그룹 프롬프트 미지원.

### 3. 설정 디렉토리: `~/.gh-symphony/`

모든 설정과 런타임 상태를 `~/.gh-symphony/`에 저장한다. 프로젝트 루트의 `.runtime/`은 CLI 모드에서 사용하지 않는다.

- **이유**: 글로벌 CLI이므로 홈 디렉토리가 자연스러움. 여러 프로젝트에서 같은 설정 공유.
- **대안 — XDG (`~/.config/gh-symphony`)**: 더 표준적이나 macOS/Windows에서 직관적이지 않음.
- **대안 — 프로젝트 로컬 (`.gh-symphony/`)**: 글로벌 CLI와 맞지 않음. 레포마다 설정 필요.

### 4. Orchestrator 통합: 프로세스 내 직접 호출

CLI가 `OrchestratorService`를 직접 인스턴스화하여 실행한다. 별도 프로세스로 orchestrator를 spawn하지 않는다.

- **이유**: 설정 전달이 간단. 에러 핸들링 통합. stdout/stderr 제어 용이.
- **대안 — child_process spawn**: 격리되지만 config 전달을 위해 파일이나 환경변수 필요. 에러 전파 복잡.

### 5. Workflow Mapping 변환: CLI가 `WorkflowLifecycleConfig` 직접 생성

CLI의 인터랙티브 매핑 결과를 `WorkflowLifecycleConfig` 형식으로 변환하여 저장한다. orchestrator가 읽는 config 포맷과 동일.

- **이유**: orchestrator 코드 변경 불필요. 기존 lifecycle 로직 100% 재사용.
- **대안 — 새 매핑 포맷 + orchestrator 변환 로직**: orchestrator에 CLI 전용 코드가 침투.

### 6. GitHub API: Projects v2 GraphQL API

프로젝트 목록, status 필드, 컬럼 옵션 조회에 GitHub GraphQL API를 사용한다.

- **이유**: Projects v2는 REST API를 제공하지 않음. GraphQL만이 프로젝트 필드/옵션 조회 가능.
- **기존 tracker-github의 GraphQL 유틸 재사용 가능 여부 확인 필요**.

### 7. 데몬 모드: PID 파일 기반 관리

`start -d`로 실행 시 `~/.gh-symphony/daemon.pid`에 PID를 기록하고, `stop`은 이 PID에 시그널을 보낸다.

- **이유**: 단순하고 외부 의존성 없음. Node.js `process.kill()`로 충분.
- **대안 — systemd/launchd 서비스**: OS별 설정 필요. 초기 버전에는 과도.
- **대안 — pm2**: 추가 의존성. 단일 프로세스에 과도.

### 8. Smart Defaults: 정규식 패턴 매칭

status 컬럼명을 정규식으로 매칭하여 역할을 자동 제안한다. 매칭 실패 시 유저에게 직접 선택을 요청한다.

```
/^(todo|to.do|ready|queued|open)$/i          → trigger
/^(in.progress|working|active|doing)$/i      → working
/^(review|in.review|pr.review|needs.review)$/i → human-review
/^(done|completed?|closed|merged|shipped)$/i  → done
/^(backlog|icebox|someday|later|blocked)$/i   → ignored
```

## Risks / Trade-offs

- **[GitHub API rate limit]** → init 시 여러 GraphQL 쿼리 실행. 단일 init에서는 문제 없으나, 빈번한 재초기화 시 rate limit 가능. → 필요 시 응답 캐싱.
- **[PAT scope 요구]** → Projects v2 접근에 `project` scope 필요. 기존 `repo` scope만 있는 유저는 토큰 재발급 필요. → init 시 scope 검증 후 명확한 안내 메시지 출력.
- **[orchestrator 내부 API 변경]** → CLI가 `OrchestratorService`를 직접 호출하므로 orchestrator 내부 변경에 영향받음. → orchestrator의 public API 표면을 명확히 정의하고 CLI가 그것만 사용.
- **[멀티 워크스페이스 확장]** → 초기 버전은 단일 워크스페이스 중심. 멀티 워크스페이스 필요 시 `workspace` 서브커맨드로 확장. → config.json의 `activeWorkspace` 패턴으로 미래 확장 준비.
- **[Windows 호환]** → `~/.gh-symphony/` 경로, 시그널 기반 데몬 관리가 Windows에서 다르게 동작. → 초기 버전은 macOS/Linux 대상. Windows는 후속 지원.

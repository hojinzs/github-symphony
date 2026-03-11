## 1. 패키지 초기 셋업

- [x] 1.1 `packages/cli/` 디렉토리 생성, `package.json` 작성 (`@gh-symphony/cli`, bin: `gh-symphony`), workspace 의존성 설정 (`core`, `orchestrator`, `tracker-github`)
- [x] 1.2 TypeScript 설정 (`tsconfig.json`), 빌드 스크립트 (`tsup` 또는 기존 빌드 도구), ESLint/Prettier 상속
- [x] 1.3 `@clack/prompts` 의존성 추가, CLI 진입점 (`src/index.ts`) 스캐폴딩 — 명령어 라우팅 구조 (command → handler 패턴)
- [x] 1.4 글로벌 옵션 파싱 (`--config`, `--verbose`, `--json`, `--no-color`) 및 설정 디렉토리 경로 해석 (`~/.gh-symphony/` 기본값)

## 2. GitHub API 클라이언트

- [x] 2.1 PAT 기반 GitHub GraphQL 클라이언트 모듈 작성 — 토큰 검증 (viewer 쿼리), scope 확인 로직
- [x] 2.2 Projects v2 쿼리 구현 — 사용자/조직 프로젝트 목록 조회 (`projectsV2`), 프로젝트 open item count
- [x] 2.3 프로젝트 상세 쿼리 구현 — status 필드(SingleSelectField) 옵션 조회, 프로젝트 아이템에서 linked repository 추출/중복제거

## 3. Workflow Status Mapping 엔진

- [x] 3.1 Smart defaults 패턴 매칭 모듈 — 정규식 기반 컬럼명→역할 자동 추론 (`trigger`, `working`, `human-review`, `done`, `ignored`)
- [x] 3.2 Human-review 모드 로직 — 4가지 모드(`plan-and-pr`, `plan-only`, `pr-only`, `none`)에 따른 phase 매핑 분기
- [x] 3.3 매핑 결과 → `WorkflowLifecycleConfig` 변환 함수 — `stateFieldName`, `planningStates`, `humanReviewStates`, `implementationStates`, `awaitingMergeStates`, `completedStates`, 전환 타겟 생성
- [x] 3.4 매핑 유효성 검증 — 필수 역할(trigger, working, done) 할당 확인, 중복 허용 규칙 적용
- [x] 3.5 매핑 결과 테스트 — 다양한 보드 레이아웃(3컬럼 최소, 7컬럼 상세, 커스텀명)에 대한 unit test

## 4. Init 위저드

- [x] 4.1 Step 1 구현 — PAT 입력 프롬프트 (password 타입), 검증, scope 확인, 실패 시 재입력 루프
- [x] 4.2 Step 2 구현 — 프로젝트 목록 조회 및 선택 UI (select 프롬프트), URL 수동 입력 옵션, 프로젝트 없을 때 안내
- [x] 4.3 Step 3 구현 — 프로젝트 아이템에서 linked repo 감지, 체크박스 multi-select로 활성화할 레포 선택
- [x] 4.4 Step 4 구현 — status 컬럼 조회 → smart defaults 적용 → 인터랙티브 매핑 (trigger, working, human-review 모드, done, ignored) → 확인 화면 (visual flow)
- [x] 4.5 Step 5-6 구현 — 런타임 선택 (Codex/Claude Code/Custom), 옵션(poll interval, concurrency, max attempts)
- [x] 4.6 Config 파일 생성 — `~/.gh-symphony/` 디렉토리 구조 생성, `config.json`, `workspaces/<id>/workspace.json`, `workflow-mapping.json` 기록
- [x] 4.7 기존 config 감지 — 재실행 시 overwrite/추가 workspace 선택 프롬프트
- [x] 4.8 Non-interactive 모드 — `--non-interactive`, `--token`, `--project`, `--runtime` 플래그 처리, smart defaults 자동 적용

## 5. Lifecycle 명령어

- [x] 5.1 `start` 명령어 — workspace config 로드, `OrchestratorFsStore` 생성, `OrchestratorService` 인스턴스화 및 실행, 포그라운드 로그 스트림 출력
- [x] 5.2 `start --daemon` — 프로세스 detach, PID 파일 기록 (`~/.gh-symphony/daemon.pid`), 로그 파일 라우팅 (`~/.gh-symphony/logs/orchestrator.log`)
- [x] 5.3 `stop` 명령어 — PID 파일 읽기, 프로세스 시그널 (SIGTERM 기본, `--force`시 SIGKILL), PID 파일 정리
- [x] 5.4 `status` 명령어 — filesystem 또는 status API에서 상태 조회, 테이블 포맷 출력, `--watch` 모드 (2초 갱신), `--json` 출력
- [x] 5.5 `run <issue>` 명령어 — issue identifier 파싱, workspace에서 레포 검증, 단일 이슈 디스패치, `--watch` 실시간 진행 출력
- [x] 5.6 `recover` 명령어 — stalled run 스캔, `--dry-run` 지원, 확인 후 재시작
- [x] 5.7 `logs` 명령어 — 로그/이벤트 파일 읽기, `--follow`, `--issue`, `--run`, `--level` 필터링

## 6. Project & Repo 관리 명령어

- [x] 6.1 `project list` — 전체 workspace 목록 출력 (프로젝트명, 레포 수, 활성 표시)
- [x] 6.2 `project switch` — 인터랙티브 workspace 전환, `config.json` `activeWorkspace` 업데이트, 데몬 실행 중 경고
- [x] 6.3 `project status` — GitHub Project 보드 현황 + 오케스트레이터 상태 교차 표시
- [x] 6.4 `repo list` / `repo add` / `repo remove` — 레포 관리, GitHub API 검증, 활성 워커 경고

## 7. Config 관리 명령어

- [x] 7.1 `config show` — 전체 설정 출력 (토큰 마스킹)
- [x] 7.2 `config set <key> <value>` — 값 검증 (duration, number, enum), 설정 파일 업데이트
- [x] 7.3 `config edit` — `$EDITOR`로 config 파일 열기

## 8. 통합 테스트 및 마무리

- [ ] 8.1 Init 위저드 E2E 테스트 — GitHub API mock으로 전체 init 플로우 검증 (PAT → Project → Repo → Mapping → Config 생성)
- [x] 8.2 Lifecycle 명령어 테스트 — start/stop/status/run 시나리오, 데몬 PID 관리 검증
- [x] 8.3 Workflow mapping 엣지 케이스 테스트 — 최소 3컬럼 보드, 동일 컬럼 다중 매핑, 전체 자동 모드(none), 커스텀 필드명
- [x] 8.4 pnpm workspace 통합 확인 — `pnpm build`, `pnpm lint`, `pnpm typecheck`에서 `packages/cli` 포함 검증
- [ ] 8.5 종료 코드 및 에러 처리 — 코드 0/1/2/3/4/130 시나리오별 검증, 에러 메시지 가독성 확인

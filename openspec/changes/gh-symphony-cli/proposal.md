## Why

현재 Symphony 오케스트레이터를 실행하려면 Control Plane 셋업, PostgreSQL, 환경변수 설정, workspace config 수동 생성 등 복잡한 단계를 거쳐야 한다. 개인 개발자나 소규모 팀이 빠르게 시작할 수 있는 진입점이 없다. `gh-symphony` CLI를 통해 `npm install -g` → `init` → `start` 세 단계로 오케스트레이터를 실행할 수 있어야 한다.

## What Changes

- **`packages/cli` 패키지 신규 추가**: `gh-symphony` 글로벌 CLI 바이너리 제공
- **인터랙티브 `init` 위저드**: GitHub PAT 검증, GitHub Project 선택, status 컬럼 → Symphony phase 매핑, AI runtime 선택, workspace config 자동 생성
- **`start` / `stop` 명령어**: 포그라운드/데몬 모드 오케스트레이터 실행 및 중지
- **`status` 명령어**: 현재 워크스페이스 상태 테이블 출력
- **`run <issue>` 명령어**: 특정 이슈 즉시 디스패치
- **`project` / `repo` / `config` 서브커맨드**: 프로젝트 전환, 레포 관리, 설정 변경
- **`logs` / `recover` 명령어**: 로그 조회 및 중단 작업 복구
- **smart defaults로 workflow mapping 자동 추론**: 프로젝트 status 컬럼명 패턴 매칭으로 기본값 제안
- **`~/.gh-symphony/` 설정 디렉토리**: Control Plane 없이 독립 동작하는 파일 기반 설정

## Capabilities

### New Capabilities
- `cli-init-wizard`: 인터랙티브 셋업 위저드 — PAT 검증, Project 선택, status-to-phase 매핑, runtime 선택, workspace config 생성
- `cli-lifecycle-commands`: start/stop/status/run/recover/logs 명령어로 오케스트레이터 라이프사이클 관리
- `cli-project-repo-management`: project switch, repo add/remove, config set/show 서브커맨드
- `workflow-status-mapping`: GitHub Project status 컬럼을 Symphony WorkflowExecutionPhase에 매핑하는 인터랙티브 설정 및 자동 추론 로직

### Modified Capabilities
- `cli-orchestrator-service`: CLI 진입점이 기존 `packages/orchestrator` 내장에서 `packages/cli` 래퍼로 확장됨. 기존 orchestrator CLI는 그대로 유지하되, `gh-symphony` CLI가 상위 레벨에서 호출.

## Impact

- **새 패키지**: `packages/cli` (의존: `core`, `orchestrator`, `tracker-github`)
- **npm 바이너리**: `gh-symphony` 글로벌 커맨드 등록 (`package.json` bin 필드)
- **설정 디렉토리**: `~/.gh-symphony/` 신규 (기존 `.runtime/` 구조와 호환)
- **GitHub API 의존성**: Projects v2 GraphQL API (프로젝트 목록, status 필드 조회)
- **인터랙티브 의존성**: `inquirer` 또는 `@clack/prompts` 등 터미널 프롬프트 라이브러리
- **기존 코드 변경 최소화**: orchestrator/worker 패키지는 변경하지 않고, CLI가 config 생성 후 기존 서비스를 호출

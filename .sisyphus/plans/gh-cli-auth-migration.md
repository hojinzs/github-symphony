# gh CLI Auth Migration — PAT 토큰 의존 제거

## TL;DR

> **Quick Summary**: PAT 토큰 입력/저장/검증 의존을 전면 제거하고 `gh` CLI 기반 인증으로 전환. CLI→Orchestrator→Worker→Runtime 전 레이어가 `gh auth token`으로 토큰을 획득하며, `GITHUB_GRAPHQL_TOKEN` env var는 CI/테스트용 폴백으로 유지.
>
> **Deliverables**:
>
> - `packages/cli/src/github/gh-auth.ts` — gh CLI 인증 모듈 (설치 확인, 인증 확인, 스코프 확인, 토큰 획득)
> - CLI `tenant add` / `init` 명령어에서 PAT 프롬프트 제거, gh CLI 기반 플로우로 교체
> - `CliGlobalConfig.token` 필드 제거, `tenant.tracker.settings.token` 기록 제거
> - `config show` / `config set token` 토큰 관련 기능 제거
> - 오케스트레이터가 시작 시 `gh auth token`으로 토큰 획득 후 워커 env에 명시적 주입
> - README.md, help.ts 문서 업데이트
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 → Task 3,4 → Task 5,6,7 → Task 10

---

## Context

### Original Request

PAT 토큰 입력을 받는 `tenant add`, `init` 동작을 변경:

1. gh CLI 설치여부 검증
2. 필요한 권한(특히 프로젝트)이 있는지 확인 → 없으면 `gh auth login --scopes` 실행해서 권한 취득 안내
3. 전체적으로 PAT 토큰 저장과 의존을 없애고 모두 gh CLI 중심으로 변경

### Interview Summary

**Key Discussions**:

- PAT 토큰이 사용되는 전체 경로 분석 완료 (CLI→config→orchestrator→worker→runtime)
- 오케스트레이터도 gh CLI 사용 가능 확인 (같은 유저 컨텍스트)
- `buildWorkerEnvironment()`는 토큰을 전달하지 않음 — `...process.env` 상속으로 전달
- 30초 폴링에 매번 subprocess는 과도 → 시작 시 1회 캐싱으로 결정
- git-credential-helper는 per-process env var 방식 유지 (global config 오염 금지)

**Research Findings**:

- `gh auth token`은 네트워크 호출 없는 로컬 읽기 (single-digit ms + subprocess 오버헤드)
- `gh auth refresh --scopes`가 스코프 추가 시 올바른 명령어 (login이 아님)
- `GH_TOKEN` env → `GITHUB_TOKEN` env → `~/.config/gh/hosts.yml` → keyring 순 우선순위
- Fine-grained PAT(`github_pat_...`)는 스코프를 리포트하지 않음 — 빈 스코프 = 스킵

### Metis Review

**Identified Gaps** (addressed):

- control-plane은 별도 인증 체계 → **스코프 밖으로 명시**
- `config-cmd.ts`의 `token` 키와 `maskToken()` 제거 필요 → Task 8에 포함
- 기존 테스트가 `process.env.GITHUB_GRAPHQL_TOKEN` 의존 → env var 폴백 유지로 해결
- `runInteractiveFromTenant()`의 `globalConfig.token` 사용 → Task 7에서 처리
- `--token` 플래그 제거 시 CI 호환성 → `GH_TOKEN` env var + `gh auth login --with-token` 안내
- daemon 모드에서 gh CLI 접근성 → 토큰을 시작 시 캐싱 후 env 주입하므로 안전

---

## Work Objectives

### Core Objective

gh CLI를 인증의 단일 진입점으로 만들어 PAT 토큰 수동 입력/저장 패턴을 완전히 제거한다.

### Concrete Deliverables

- `packages/cli/src/github/gh-auth.ts` — 새 모듈
- `packages/cli/src/github/gh-auth.test.ts` — 새 테스트
- `packages/cli/src/commands/tenant.ts` — PAT 프롬프트 제거
- `packages/cli/src/commands/init.ts` — PAT 프롬프트 제거
- `packages/cli/src/config.ts` — `CliGlobalConfig.token` 제거
- `packages/cli/src/commands/config-cmd.ts` — token 관련 기능 제거
- `packages/cli/src/commands/help.ts` — `--token` 예시 제거
- `packages/tracker-github/src/orchestrator-adapter.ts` — token 리졸루션 업데이트
- `packages/orchestrator/src/service.ts` — 워커 env에 토큰 명시적 주입
- `README.md` — 인증 문서 업데이트

### Definition of Done

- [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 전체 통과
- [ ] `~/.gh-symphony/config.json`에 `token` 필드 없음
- [ ] `tenant.json`에 `tracker.settings.token` 없음
- [ ] `gh-symphony tenant add`가 PAT 입력 없이 gh CLI로 진행
- [ ] `gh-symphony init`가 PAT 입력 없이 gh CLI로 진행

### Must Have

- gh CLI 미설치 시 명확한 에러 메시지 + 설치 안내
- gh CLI 미인증 시 `gh auth login --scopes repo,read:org,project` 안내
- 스코프 부족 시 `gh auth refresh --scopes repo,read:org,project` 안내
- `GITHUB_GRAPHQL_TOKEN` env var 폴백 유지 (테스트/CI 호환)
- 토큰 브로커 패턴(`GITHUB_TOKEN_BROKER_URL/SECRET`) 그대로 유지

### Must NOT Have (Guardrails)

- `apps/control-plane/` 코드 수정 금지 — 별도 인증 체계
- `gh auth setup-git` 전역 설정 금지 — per-process env var 방식 유지
- 오케스트레이터 폴링 핫패스에 `gh auth status` 호출 금지
- GitHub Enterprise 멀티호스트 지원 추가 금지
- 토큰 브로커 패턴 수정 금지 — `GITHUB_TOKEN_BROKER_URL/SECRET` 관련 코드 유지
- `OrchestratorTrackerAdapter` 인터페이스 시그니처 변경 금지

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (vitest)
- **Automated tests**: YES (TDD for gh-auth.ts, tests-after for integration changes)
- **Framework**: vitest (`pnpm test`)

### QA Policy

Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI commands**: Use interactive_bash (tmux) — Run command, validate output
- **Module tests**: Use Bash (`pnpm --filter @gh-symphony/cli test`)
- **Build verification**: Use Bash (`pnpm build && pnpm typecheck`)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — start immediately):
├── Task 1: gh-auth.ts 모듈 + 테스트 [deep]
└── Task 2: config 타입에서 token 필드 제거 [quick]

Wave 2 (Core changes — after Wave 1, MAX PARALLEL):
├── Task 3: orchestrator-adapter.ts 토큰 리졸루션 업데이트 (depends: 1) [quick]
├── Task 4: writeConfig() 토큰 제거 (depends: 2) [quick]
├── Task 5: tenant.ts interactive 플로우 변경 (depends: 1, 4) [unspecified-high]
├── Task 6: tenant.ts non-interactive 플로우 변경 (depends: 1, 4) [quick]
├── Task 7: init.ts 전체 플로우 변경 (depends: 1, 4) [unspecified-high]
└── Task 8: config-cmd.ts token 기능 제거 (depends: 2) [quick]

Wave 3 (Orchestrator + Docs — after Wave 2):
├── Task 9:  orchestrator service.ts 워커 env 토큰 주입 (depends: 1) [quick]
├── Task 10: help.ts + README.md 문서 업데이트 (depends: 5, 6, 7) [writing]
└── Task 11: 전체 빌드 + 테스트 + 타입체크 검증 (depends: all) [quick]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 5 → Task 10 → Task 11 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 6 (Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks        | Wave |
| ---- | ---------- | ------------- | ---- |
| 1    | —          | 3, 5, 6, 7, 9 | 1    |
| 2    | —          | 4, 8          | 1    |
| 3    | 1          | 11            | 2    |
| 4    | 2          | 5, 6, 7       | 2    |
| 5    | 1, 4       | 10            | 2    |
| 6    | 1, 4       | 10            | 2    |
| 7    | 1, 4       | 10            | 2    |
| 8    | 2          | 11            | 2    |
| 9    | 1          | 11            | 3    |
| 10   | 5, 6, 7    | 11            | 3    |
| 11   | all        | F1-F4         | 3    |

### Agent Dispatch Summary

- **Wave 1**: **2** — T1 → `deep`, T2 → `quick`
- **Wave 2**: **6** — T3 → `quick`, T4 → `quick`, T5 → `unspecified-high`, T6 → `quick`, T7 → `unspecified-high`, T8 → `quick`
- **Wave 3**: **3** — T9 → `quick`, T10 → `writing`, T11 → `quick`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. gh-auth.ts 모듈 생성 + TDD 테스트

  **What to do**:
  - `packages/cli/src/github/gh-auth.ts` 새 모듈 생성
  - `packages/cli/src/github/gh-auth.test.ts` 테스트 파일 생성 (TDD — 테스트 먼저)
  - 의존성 주입 패턴: `execImpl?: typeof execFileSync` 파라미터로 subprocess 모킹 가능하게
  - 내보내기할 함수들:
    - `checkGhInstalled(opts?): boolean` — `gh --version` 실행, 설치 여부 반환
    - `checkGhAuthenticated(opts?): { authenticated: boolean; login?: string }` — `gh auth status` stderr 파싱 ("Logged in to github.com account **<login>**" 패턴)
    - `checkGhScopes(opts?): { valid: boolean; missing: string[]; scopes: string[] }` — `gh auth status` stderr의 "Token scopes: 'repo', 'read:org', 'project'" 라인 파싱으로 스코프 확인. 스코프 라인 없으면 (fine-grained PAT) → valid: true로 처리 (스코프 체크 스킵)
    - `getGhToken(opts?): string` — 토큰 해석 우선순위: `process.env.GITHUB_GRAPHQL_TOKEN` → `execFileSync("gh", ["auth", "token"])` → throw
    - `ensureGhAuth(opts?): { login: string; token: string }` — 위 함수들 조합, 실패 시 구체적 안내 메시지 반환
  - `GhAuthError` 클래스 내보내기 (코드별 에러: `not_installed`, `not_authenticated`, `missing_scopes`, `token_failed`)
  - `execFileSync` 사용 (NOT `execSync`) — shell injection 방지
  - `gh auth status`는 stderr로 출력 — `execFileSync`의 `{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }` 옵션으로 stderr 캡처. exit code 1 = 미인증, exit code 0 = 인증됨
  - **중요**: `gh auth status`는 `--json` 플래그를 지원하지 않음. 반드시 plain text stderr 파싱으로 구현

  **Must NOT do**:
  - 네트워크 호출 직접 수행 금지 — gh CLI subprocess만 사용
  - global state 변경 금지
  - `apps/control-plane/` 참조 금지

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 새 모듈 설계 + TDD 패턴 + subprocess 모킹 + 에러 핸들링이 복잡
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: UI 없음
    - `git-master`: git 작업 아님

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Tasks 3, 5, 6, 7, 9
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `packages/cli/src/github/client.ts:73-82` — 기존 `createClient(token)` 패턴. 새 모듈은 이와 대칭되는 API 제공. `validateToken()` + `checkRequiredScopes()` 패턴을 참고하여 함수 시그니처 설계
  - `packages/cli/src/github/client.ts:86-134` — `validateToken()`, `checkRequiredScopes()` 구현. 스코프 체크 로직의 required 배열 `["repo", "read:org", "project"]`을 그대로 재사용
  - `packages/runtime-codex/src/github-graphql-tool.ts:57-116` — `resolveGitHubGraphQLToken()`의 폴백 체인 패턴. env var → broker → error. 새 모듈은 env var → gh CLI → error 순

  **API/Type References**:
  - `packages/cli/src/github/client.ts:10-14` — `ViewerInfo` 타입 (`login`, `name`, `scopes`). gh-auth의 `checkGhAuthenticated` 반환 타입 참고
  - `packages/cli/src/github/client.ts:63-71` — `GitHubApiError` 클래스. `GhAuthError` 클래스 설계 참고

  **Test References**:
  - `packages/cli/src/commands/init.test.ts` — CLI 테스트 패턴, 모킹 전략 참고
  - `packages/runtime-codex/src/launcher.test.ts` — subprocess 모킹 패턴 참고

  **External References**:
  - `gh auth token` — 토큰 출력 (stdout, exit 0). 미인증 시 exit 1 + stderr
  - `gh auth status` — 인증 상태를 **stderr**로 출력. exit 0 = 인증됨, exit 1 = 미인증. 출력 형식 예시:
    ```
    github.com
      ✓ Logged in to github.com account <username> (<path>)
      - Active account: true
      - Git operations protocol: https
      - Token: ghp_****
      - Token scopes: 'project', 'read:org', 'repo'
    ```
    **주의**: `--json` 플래그 미지원. plain text stderr 파싱 필수
  - `gh auth refresh --scopes repo,read:org,project` — 스코프 추가 명령어 (login이 아닌 refresh)

  **WHY Each Reference Matters**:
  - `client.ts`의 패턴을 따라야 기존 코드와 일관성 유지
  - 스코프 체크 로직의 required 배열이 동일 → 재사용 또는 상수 공유
  - env var 폴백 패턴은 `resolveGitHubGraphQLToken`에서 이미 검증된 패턴

  **Acceptance Criteria**:
  - [ ] `packages/cli/src/github/gh-auth.ts` 파일 존재
  - [ ] `packages/cli/src/github/gh-auth.test.ts` 파일 존재
  - [ ] `pnpm --filter @gh-symphony/cli test` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: gh CLI 미설치 시 에러 처리
    Tool: Bash
    Preconditions: execImpl 모킹 — gh --version이 ENOENT throw
    Steps:
      1. `checkGhInstalled({ execImpl: mockExec })` 호출
      2. 반환값 확인
    Expected Result: `false` 반환
    Failure Indicators: throw 발생 또는 true 반환
    Evidence: .sisyphus/evidence/task-1-gh-not-installed.txt

  Scenario: gh CLI 인증됨 + 올바른 스코프
    Tool: Bash
    Preconditions: execImpl 모킹 — gh auth token → "ghp_test123", gh auth status → 정상 출력
    Steps:
      1. `ensureGhAuth({ execImpl: mockExec })` 호출
      2. 반환값 확인
    Expected Result: `{ login: "testuser", token: "ghp_test123" }` 반환
    Failure Indicators: GhAuthError throw
    Evidence: .sisyphus/evidence/task-1-gh-auth-success.txt

  Scenario: GITHUB_GRAPHQL_TOKEN env var 폴백
    Tool: Bash
    Preconditions: process.env.GITHUB_GRAPHQL_TOKEN = "ghp_env_token_abc"
    Steps:
      1. `getGhToken()` 호출 (execImpl 없음 — env var가 우선)
      2. 반환값 확인
    Expected Result: `"ghp_env_token_abc"` 반환 (gh CLI 호출 없이)
    Failure Indicators: subprocess 호출 발생
    Evidence: .sisyphus/evidence/task-1-env-var-fallback.txt

  Scenario: 스코프 부족 시 안내 메시지
    Tool: Bash
    Preconditions: execImpl 모킹 — gh auth status → scopes에 "project" 없음
    Steps:
      1. `checkGhScopes({ execImpl: mockExec })` 호출
      2. 반환값 확인
    Expected Result: `{ valid: false, missing: ["project"], scopes: ["repo", "read:org"] }` 반환
    Failure Indicators: valid: true 반환
    Evidence: .sisyphus/evidence/task-1-missing-scopes.txt
  ```

  **Commit**: YES
  - Message: `feat(cli): add gh-auth module for gh CLI-based authentication`
  - Files: `packages/cli/src/github/gh-auth.ts`, `packages/cli/src/github/gh-auth.test.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli test`

- [x] 2. config 타입에서 token 필드 제거

  **What to do**:
  - `packages/cli/src/config.ts` — `CliGlobalConfig` 타입에서 `token: string | null` 필드 제거
  - `loadGlobalConfig`와 `saveGlobalConfig`가 `token` 없이 동작하는지 확인
  - 기존 config 파일에 `token` 필드가 있어도 로드 시 에러 없이 무시되도록 (TypeScript 타입에서 제거만 하면 JSON.parse는 알아서 무시)
  - `WriteConfigInput` 타입에서 `token: string` 필드 제거 — `packages/cli/src/commands/init.ts:826-844`
  - 이 단계에서는 타입만 변경. 실제 호출부(`writeConfig()`, `tenantAdd()` 등)는 후속 태스크에서 처리

  **Must NOT do**:
  - `writeConfig()` 함수 본문은 아직 수정하지 않음 (Task 4에서 처리)
  - 다른 파일 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 타입 필드 2개 제거, 단일 파일 변경
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Tasks 4, 8
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `packages/cli/src/config.ts:14-18` — `CliGlobalConfig` 타입 정의. `token: string | null` 라인 제거 대상
  - `packages/cli/src/commands/init.ts:826-844` — `WriteConfigInput` 타입 정의. `token: string` 라인 제거 대상

  **WHY Each Reference Matters**:
  - 정확히 어떤 라인의 어떤 필드를 제거하는지 명확화

  **Acceptance Criteria**:
  - [ ] `CliGlobalConfig` 타입에 `token` 필드 없음
  - [ ] `WriteConfigInput` 타입에 `token` 필드 없음
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → 컴파일 에러 확인 (의도적 — 후속 태스크에서 수정)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 타입 변경이 정확한지 확인
    Tool: Bash
    Preconditions: Task 2 완료
    Steps:
      1. grep -n "token" packages/cli/src/config.ts 실행
      2. CliGlobalConfig 타입 블록에 token 필드가 없는지 확인
      3. grep -n "token: string" packages/cli/src/commands/init.ts | grep WriteConfigInput 실행
    Expected Result: CliGlobalConfig에 token 없음, WriteConfigInput에 token 없음
    Failure Indicators: token 필드가 여전히 존재
    Evidence: .sisyphus/evidence/task-2-type-removal.txt

  Scenario: 기존 config.json 로드가 에러 없이 동작
    Tool: Bash
    Preconditions: `{"activeTenant": "test", "token": "ghp_old", "tenants": ["test"]}` 형태의 config.json
    Steps:
      1. loadGlobalConfig() 호출 시 token 필드가 있는 JSON 파싱
      2. 에러 없이 로드되는지 확인
    Expected Result: 에러 없음 (TypeScript 런타임에서 extra fields 무시)
    Failure Indicators: JSON.parse 에러
    Evidence: .sisyphus/evidence/task-2-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): remove token field from CliGlobalConfig and WriteConfigInput types`
  - Files: `packages/cli/src/config.ts`, `packages/cli/src/commands/init.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck 2>&1 || true` (의도적 에러 — 호출부 미수정)

- [x] 3. orchestrator-adapter.ts 토큰 리졸루션에서 stored token 제거

  **What to do**:
  - `packages/tracker-github/src/orchestrator-adapter.ts` — `listIssues()` 메서드의 토큰 해석 체인 변경
  - 현재: `dependencies.token` → `tenant.tracker.settings?.token` → `process.env.GITHUB_GRAPHQL_TOKEN`
  - 변경: `dependencies.token` → `process.env.GITHUB_GRAPHQL_TOKEN` → error
  - `tenant.tracker.settings?.token` 참조 라인 제거 (line 11)
  - 에러 메시지 업데이트: "GITHUB_GRAPHQL_TOKEN is required" → "GITHUB_GRAPHQL_TOKEN environment variable is required. Run 'gh auth token' or set the variable."
  - 관련 테스트 `packages/tracker-github/src/tracker-github.test.ts` 업데이트

  **Must NOT do**:
  - `OrchestratorTrackerAdapter` 인터페이스 시그니처 변경 금지
  - `buildWorkerEnvironment()` 수정 금지
  - `dependencies.token` 주입 경로 제거 금지 (테스트 격리에 필요)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일 내 3줄 변경
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4-8)
  - **Blocks**: Task 11
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `packages/tracker-github/src/orchestrator-adapter.ts:7-35` — 전체 `listIssues()` 구현. 토큰 해석 체인이 lines 9-12에 있음

  **API/Type References**:
  - `packages/core/src/contracts/tracker-adapter.ts` — `OrchestratorTrackerAdapter` 인터페이스. `dependencies.token?: string` 유지해야 함

  **Test References**:
  - `packages/tracker-github/src/tracker-github.test.ts` — 기존 테스트에서 token 관련 케이스 확인

  **Acceptance Criteria**:
  - [ ] `tenant.tracker.settings?.token` 참조 없음
  - [ ] `dependencies.token` 경로는 유지
  - [ ] `process.env.GITHUB_GRAPHQL_TOKEN` 폴백 유지
  - [ ] `pnpm --filter @gh-symphony/tracker-github test` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: env var로 토큰 해석 성공
    Tool: Bash
    Preconditions: process.env.GITHUB_GRAPHQL_TOKEN = "ghp_test_token"
    Steps:
      1. listIssues(tenant, {}) 호출 — tenant.tracker.settings에 token 없음
      2. fetch 호출 시 Authorization 헤더 확인
    Expected Result: "Bearer ghp_test_token" 헤더 사용
    Evidence: .sisyphus/evidence/task-3-env-token.txt

  Scenario: 토큰 없을 때 에러 메시지
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN 미설정, tenant.tracker.settings.token 없음
    Steps:
      1. listIssues(tenant, {}) 호출
    Expected Result: Error throw — "GITHUB_GRAPHQL_TOKEN environment variable is required"
    Evidence: .sisyphus/evidence/task-3-no-token-error.txt
  ```

  **Commit**: YES
  - Message: `refactor(tracker-github): remove stored token from resolution chain`
  - Files: `packages/tracker-github/src/orchestrator-adapter.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/tracker-github test`

- [x] 4. writeConfig()에서 토큰 저장 제거

  **What to do**:
  - `packages/cli/src/commands/init.ts` — `writeConfig()` 함수 본문 수정:
    - `saveTenantConfig()` 호출에서 `tracker.settings.token: input.token` 제거 (line 889)
    - `saveGlobalConfig()` 호출에서 `token: input.token` 제거 (line 907)
  - `writeConfig()` 호출하는 모든 곳에서 `token` 인자 제거:
    - `tenant.ts:198-206` — `writeConfig(options.configDir, { tenantId, token: flags.token, ... })` 에서 `token` 제거
    - `tenant.ts:452-465` — interactive 모드 writeConfig 호출에서 `token` 제거
    - `init.ts` non-interactive 모드 내부에서도 token 참조 정리

  **Must NOT do**:
  - `writeConfig()` 시그니처 외의 다른 함수 수정 금지 (CLI 플로우는 Task 5-7)
  - 기존 config 파일 마이그레이션 로직 추가 금지 (이전 파일은 그대로 두면 됨)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 함수 내부에서 3-4개 라인 제거
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 5-8)
  - **Blocks**: Tasks 5, 6, 7
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/init.ts:855-933` — `writeConfig()` 전체 함수. token이 사용되는 위치: line 889 (`tracker.settings.token`), line 907 (`globalConfig.token`)
  - `packages/cli/src/commands/tenant.ts:198-206` — non-interactive writeConfig 호출
  - `packages/cli/src/commands/tenant.ts:452-465` — interactive writeConfig 호출

  **Acceptance Criteria**:
  - [ ] `writeConfig()` 함수에 `token` 파라미터 없음
  - [ ] `saveTenantConfig()` 호출에 `tracker.settings.token` 없음
  - [ ] `saveGlobalConfig()` 호출에 `token` 없음
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS (또는 Task 5-7 완료 후)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: tenant.json에 token 필드가 기록되지 않음
    Tool: Bash
    Preconditions: writeConfig() 호출 후 생성된 tenant.json 확인
    Steps:
      1. writeConfig() 결과로 생성된 tenant.json 파일 읽기
      2. tracker.settings 객체에 token 키 존재 확인
    Expected Result: token 키 없음 — projectId, blockedByFieldName만 존재
    Evidence: .sisyphus/evidence/task-4-no-token-in-config.txt

  Scenario: config.json에 token 필드가 기록되지 않음
    Tool: Bash
    Preconditions: writeConfig() 호출 후 생성된 config.json 확인
    Steps:
      1. 생성된 config.json 읽기
      2. token 키 존재 확인
    Expected Result: token 키 없음 — activeTenant, tenants만 존재
    Evidence: .sisyphus/evidence/task-4-no-token-in-global.txt
  ```

  **Commit**: YES (groups with Tasks 5-7)
  - Message: `refactor(cli): remove token from writeConfig and tenant config writes`
  - Files: `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/tenant.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 5. tenant.ts interactive 플로우 — PAT 프롬프트를 gh CLI로 교체

  **What to do**:
  - `packages/cli/src/commands/tenant.ts` — `tenantAddInteractive()` 함수 (lines 220-480) 수정
  - **제거**: Step 1 PAT 입력 루프 전체 (`while(true) { p.password(...) }` — lines 246-286)
  - **추가**: `import { ensureGhAuth } from "../github/gh-auth.js"`
  - **추가**: Step 1을 gh CLI 검증으로 교체:
    1. `ensureGhAuth()` 호출 — gh 설치/인증/스코프 한번에 확인
    2. 실패 시 `GhAuthError` 분기:
       - `not_installed` → `p.log.error("gh CLI가 설치되어 있지 않습니다. https://cli.github.com 에서 설치하세요.")`
       - `not_authenticated` → `p.log.error("gh auth login --scopes repo,read:org,project 를 실행하세요.")`
       - `missing_scopes` → `p.log.error("gh auth refresh --scopes repo,read:org,project 를 실행하세요.")`
    3. 성공 시 `{ login, token }` 받아서 `createClient(token)` 호출 → 기존 플로우 계속
  - Step 번호 조정: Step 1/4 → Step 1/3 (PAT 입력 스텝 제거, 나머지 동일)
  - `token` 변수 대신 `ensureGhAuth()` 반환값 사용
  - confirmation summary에서 `User: viewer.login` 유지 (viewer는 `validateToken()` 대신 `ensureGhAuth().login` 사용)
  - `validateToken()`, `checkRequiredScopes()` import 제거 가능 (gh-auth가 대체)

  **Must NOT do**:
  - Step 2-4 (프로젝트 선택, 리포 선택, 런타임 선택) 수정 금지
  - `writeConfig()` 호출 구조 변경 금지 (token 인자는 Task 4에서 이미 제거)
  - `tenantList()`, `tenantRemove()` 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 기존 interactive 플로우의 Step 1을 완전히 재작성 + clack 프롬프트 통합
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 6, 7, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 1, 4

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/tenant.ts:220-480` — `tenantAddInteractive()` 전체. Lines 246-286이 PAT 입력 루프로 교체 대상
  - `packages/cli/src/commands/tenant.ts:1-13` — import 문. `validateToken`, `checkRequiredScopes` 제거, `ensureGhAuth` 추가
  - `packages/cli/src/commands/tenant.ts:422-430` — confirmation summary. `User: ${viewer.login}` 부분 유지

  **API/Type References**:
  - Task 1에서 생성한 `packages/cli/src/github/gh-auth.ts` — `ensureGhAuth()`, `GhAuthError` 타입
  - `packages/cli/src/github/client.ts:73-82` — `createClient(token)` — gh-auth에서 받은 token으로 호출

  **Acceptance Criteria**:
  - [ ] `p.password()` 호출 없음 in `tenantAddInteractive()`
  - [ ] `ensureGhAuth()` 호출 존재
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: gh CLI 인증 완료 상태에서 tenant add 성공
    Tool: Bash
    Preconditions: gh CLI 설치 + 인증 완료 + 올바른 스코프
    Steps:
      1. tenant add interactive 플로우 시작
      2. PAT 입력 프롬프트 없이 "Authenticated as <login>" 출력 확인
      3. 프로젝트 선택 단계로 바로 진행 확인
    Expected Result: Step 1이 gh CLI 검증으로 자동 통과, Step 2로 진행
    Evidence: .sisyphus/evidence/task-5-interactive-gh-auth.txt

  Scenario: gh CLI 미설치 시 에러 메시지
    Tool: Bash
    Preconditions: gh CLI 미설치 환경 (PATH에서 gh 제거)
    Steps:
      1. tenant add interactive 실행
    Expected Result: "gh CLI가 설치되어 있지 않습니다" 에러 + 설치 안내 URL
    Evidence: .sisyphus/evidence/task-5-gh-not-installed.txt
  ```

  **Commit**: YES
  - Message: `feat(cli): replace PAT prompt with gh CLI auth in tenant add interactive`
  - Files: `packages/cli/src/commands/tenant.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 6. tenant.ts non-interactive 플로우 — `--token` 플래그 제거

  **What to do**:
  - `packages/cli/src/commands/tenant.ts` — `tenantAddNonInteractive()` (lines 109-216) 수정
  - **제거**: `--token` 플래그 파싱 (`parseTenantAddFlags`의 `case "--token"` — line 48-50)
  - **제거**: `TenantAddFlags.token` 타입 필드
  - **제거**: `if (!flags.token)` 검증 (lines 113-119)
  - **추가**: `getGhToken()` 호출로 토큰 획득 (`import { getGhToken } from "../github/gh-auth.js"`)
  - `createClient(flags.token)` → `createClient(getGhToken())` 변경
  - `validateToken(client)` + `checkRequiredScopes()` 호출 유지 — 토큰 유효성은 GitHub API로 검증
  - 에러 핸들링: `getGhToken()` 실패 시 → "gh CLI 인증 필요. 'gh auth login --scopes repo,read:org,project' 또는 GITHUB_GRAPHQL_TOKEN 환경변수를 설정하세요."

  **Must NOT do**:
  - interactive 플로우 수정 금지 (Task 5에서 처리)
  - `--project`, `--runtime` 플래그 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 플래그 파싱 3줄 제거 + 토큰 획득 1줄 변경
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3-5, 7, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 1, 4

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/tenant.ts:31-64` — `TenantAddFlags` 타입 + `parseTenantAddFlags()`. `token` 관련 라인 제거
  - `packages/cli/src/commands/tenant.ts:109-216` — `tenantAddNonInteractive()` 전체

  **Acceptance Criteria**:
  - [ ] `--token` 플래그 파싱 없음
  - [ ] `getGhToken()` 호출 존재
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: non-interactive 모드에서 --token 없이 성공
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN 환경변수 설정
    Steps:
      1. gh-symphony tenant add --non-interactive --project PVT_xxx 실행
      2. --token 없이 토큰 획득 확인
    Expected Result: GITHUB_GRAPHQL_TOKEN에서 토큰 획득 → 정상 진행
    Evidence: .sisyphus/evidence/task-6-non-interactive-no-token-flag.txt

  Scenario: non-interactive 모드에서 토큰 미설정 시 에러
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN 미설정 + gh CLI 미인증
    Steps:
      1. gh-symphony tenant add --non-interactive --project PVT_xxx 실행
    Expected Result: "gh CLI 인증 필요" 에러 메시지 + exit code 1
    Evidence: .sisyphus/evidence/task-6-no-token-error.txt
  ```

  **Commit**: YES (groups with Task 5)
  - Message: `feat(cli): replace --token flag with gh CLI auth in tenant add non-interactive`
  - Files: `packages/cli/src/commands/tenant.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 7. init.ts 전체 플로우 — PAT 프롬프트를 gh CLI로 교체

  **What to do**:
  - `packages/cli/src/commands/init.ts` — 3개 경로 모두 수정:

  **A. `runNonInteractive()` (lines 343-465)**:
  - `if (!flags.token)` 검증 제거 (lines 347-352)
  - `createClient(flags.token)` → `createClient(getGhToken())` 변경
  - `validateToken(client)` + `checkRequiredScopes()` 유지 (토큰 유효성 검증)
  - `--token` 플래그 파싱 제거 (`parseInitFlags`의 `case "--token"` — line 87-89)
  - `InitFlags.token` 타입 필드 제거

  **B. `runInteractiveStandalone()` (lines 594-782)**:
  - Step 1 PAT 입력 루프 전체 제거 (`while(true) { p.password(...) }` — lines 600-639)
  - `ensureGhAuth()` 호출로 교체 → `{ login, token }` 반환
  - `createClient(token)` 호출은 유지 → 프로젝트 목록 조회에 필요
  - Step 번호 조정: 3단계 → 2단계 (PAT 스텝 제거)

  **C. `runInteractiveFromTenant()` (lines 485-590)**:
  - `const token = globalConfig.token` (line 559) → `const token = getGhToken()` 변경
  - `if (token && projId)` 조건은 유지 (토큰 없으면 ecosystem 생성 스킵)

  **Must NOT do**:
  - `writeEcosystem()`, `generateWorkflowMarkdown()` 수정 금지
  - `promptBlockedByField()` 수정 금지
  - `abortIfCancelled()`, `generateTenantId()` 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 3개 경로 동시 수정, 각각의 토큰 참조를 gh-auth로 교체
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3-6, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 1, 4

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/init.ts:63-108` — `InitFlags` 타입 + `parseInitFlags()`. `token` 관련 라인 제거
  - `packages/cli/src/commands/init.ts:343-465` — `runNonInteractive()` 전체
  - `packages/cli/src/commands/init.ts:594-782` — `runInteractiveStandalone()` 전체
  - `packages/cli/src/commands/init.ts:485-590` — `runInteractiveFromTenant()`. Line 559 `globalConfig.token` 교체

  **API/Type References**:
  - Task 1의 `gh-auth.ts` — `getGhToken()`, `ensureGhAuth()`, `GhAuthError`

  **Acceptance Criteria**:
  - [ ] `p.password()` 호출 없음 in `runInteractiveStandalone()`
  - [ ] `flags.token` 참조 없음 in `runNonInteractive()`
  - [ ] `globalConfig.token` 참조 없음 in `runInteractiveFromTenant()`
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS
  - [ ] `pnpm --filter @gh-symphony/cli test` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: init standalone interactive — gh CLI 인증으로 진행
    Tool: Bash
    Preconditions: gh CLI 인증 완료, 테넌트 미설정
    Steps:
      1. init interactive 실행
      2. PAT 프롬프트 없이 프로젝트 선택으로 진행 확인
    Expected Result: Step 1이 gh CLI 자동 검증, Step 2 프로젝트 선택으로 바로 진행
    Evidence: .sisyphus/evidence/task-7-init-interactive.txt

  Scenario: init non-interactive — --token 없이 GITHUB_GRAPHQL_TOKEN으로
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN 설정
    Steps:
      1. gh-symphony init --non-interactive --project PVT_xxx 실행
    Expected Result: --token 없이 정상 동작
    Evidence: .sisyphus/evidence/task-7-init-non-interactive.txt

  Scenario: init from-tenant — globalConfig.token 대신 gh CLI
    Tool: Bash
    Preconditions: 테넌트 설정 완료, gh CLI 인증됨
    Steps:
      1. cd my-repo && gh-symphony init 실행
      2. tenant 기반 WORKFLOW.md 생성 확인
    Expected Result: gh auth token으로 토큰 획득 → ecosystem 생성 성공
    Evidence: .sisyphus/evidence/task-7-init-from-tenant.txt
  ```

  **Commit**: YES
  - Message: `feat(cli): replace PAT prompt with gh CLI auth in init command`
  - Files: `packages/cli/src/commands/init.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli test`

- [x] 8. config-cmd.ts — token 관련 기능 제거

  **What to do**:
  - `packages/cli/src/commands/config-cmd.ts` 수정:
  - **`configShow()`**: `token: config.token ? maskToken(config.token) : null` 라인 제거 (line 47). `Token:` 출력 라인 제거 (line 59). JSON 출력에서도 token 제외
  - **`VALID_KEYS`**: `token: { type: "string" }` 항목 제거 (line 74)
  - **`configSet()`**: `case "token":` 분기 제거 (lines 117-118). `maskToken(value)` 사용 제거 (line 124)
  - **`maskToken()` 함수**: 삭제 (lines 65-68) — 더 이상 사용처 없음
  - import 정리: `CliGlobalConfig` 타입에 token 없으므로 자동 정리

  **Must NOT do**:
  - `configEdit()` 수정 금지 — 에디터로 직접 열기는 유지
  - `active-tenant` 관련 로직 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일, 명확한 라인 제거
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3-7)
  - **Blocks**: Task 11
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/config-cmd.ts:36-63` — `configShow()`. Lines 47, 59 제거
  - `packages/cli/src/commands/config-cmd.ts:72-75` — `VALID_KEYS`. Line 74 제거
  - `packages/cli/src/commands/config-cmd.ts:106-126` — `configSet()`. Lines 117-118, 124 수정
  - `packages/cli/src/commands/config-cmd.ts:65-68` — `maskToken()`. 전체 삭제

  **Acceptance Criteria**:
  - [ ] `config show` 출력에 `Token:` 라인 없음
  - [ ] `config set token <value>` → "Unknown config key: token" 에러
  - [ ] `maskToken` 함수 없음
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: config show에 token 없음
    Tool: Bash
    Preconditions: config.json에 activeTenant, tenants만 존재
    Steps:
      1. gh-symphony config show 실행
      2. 출력 확인
    Expected Result: "Active tenant:", "Tenants:" 라인만 존재. "Token:" 라인 없음
    Evidence: .sisyphus/evidence/task-8-config-show-no-token.txt

  Scenario: config set token 거부
    Tool: Bash
    Steps:
      1. gh-symphony config set token ghp_xxx 실행
    Expected Result: "Unknown config key: token" 에러 + exit code 2
    Evidence: .sisyphus/evidence/task-8-config-set-token-rejected.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): remove token from config show/set commands`
  - Files: `packages/cli/src/commands/config-cmd.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/cli typecheck`

- [x] 9. orchestrator service.ts — 워커 env에 토큰 명시적 주입

  **What to do**:
  - `packages/orchestrator/src/service.ts` — `startRun()` 메서드 수정 (line 518-558 영역)
  - 현재: `env: { ...process.env, ... }` — 암묵적 상속
  - 변경: `GITHUB_GRAPHQL_TOKEN`을 명시적으로 주입:
    ```typescript
    GITHUB_GRAPHQL_TOKEN: process.env.GITHUB_GRAPHQL_TOKEN ?? "",
    ```
  - 이렇게 하면 오케스트레이터가 `gh auth token`으로 획득한 토큰이 env에 있으면 워커에 전달
  - `packages/cli/src/commands/start.ts` — 오케스트레이터 시작 전에 `getGhToken()` 호출하여 `process.env.GITHUB_GRAPHQL_TOKEN` 설정:
    ```typescript
    import { getGhToken } from "../github/gh-auth.js";
    // 시작 전 토큰 캐싱
    if (!process.env.GITHUB_GRAPHQL_TOKEN) {
      try {
        process.env.GITHUB_GRAPHQL_TOKEN = getGhToken();
      } catch {
        // gh CLI 미설치/미인증 시 — env var 폴백 없으면 에러
      }
    }
    ```
  - 이렇게 하면: env var 이미 있으면 그대로 사용, 없으면 gh CLI에서 1회 획득 후 캐싱

  **Must NOT do**:
  - `OrchestratorService` 생성자 시그니처 변경 금지
  - `service.ts`의 다른 메서드 수정 금지
  - 토큰 갱신/TTL 로직 추가 금지 (gh OAuth 토큰은 만료 없음)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 2개 파일, 각각 3-5줄 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11)
  - **Blocks**: Task 11
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `packages/orchestrator/src/service.ts:518-558` — worker spawn env 블록. `...process.env` 뒤에 `GITHUB_GRAPHQL_TOKEN` 명시적 추가
  - `packages/cli/src/commands/start.ts:174-271` — foreground 모드 핸들러. 오케스트레이터 서비스 생성 전 토큰 캐싱 위치

  **API/Type References**:
  - Task 1의 `gh-auth.ts` — `getGhToken()` 함수

  **Acceptance Criteria**:
  - [ ] `service.ts` worker spawn env에 `GITHUB_GRAPHQL_TOKEN` 명시적 존재
  - [ ] `start.ts`에서 `getGhToken()` 호출하여 env에 캐싱
  - [ ] `pnpm --filter @gh-symphony/orchestrator test` → PASS
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 오케스트레이터 시작 시 gh token 캐싱
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN 미설정, gh CLI 인증 완료
    Steps:
      1. start 핸들러 실행
      2. process.env.GITHUB_GRAPHQL_TOKEN 설정 확인
    Expected Result: getGhToken()에서 획득한 토큰이 process.env에 설정
    Evidence: .sisyphus/evidence/task-9-token-caching.txt

  Scenario: env var 이미 있으면 gh CLI 호출 안 함
    Tool: Bash
    Preconditions: GITHUB_GRAPHQL_TOKEN="ghp_existing" 설정
    Steps:
      1. start 핸들러 실행
      2. gh CLI subprocess 호출 없음 확인
    Expected Result: 기존 env var 유지, getGhToken() 내부에서 env var 우선
    Evidence: .sisyphus/evidence/task-9-env-var-priority.txt
  ```

  **Commit**: YES
  - Message: `feat(orchestrator): inject gh-resolved token into worker environment`
  - Files: `packages/orchestrator/src/service.ts`, `packages/cli/src/commands/start.ts`
  - Pre-commit: `pnpm --filter @gh-symphony/orchestrator test`

- [x] 10. help.ts + README.md 문서 업데이트

  **What to do**:
  - `packages/cli/src/commands/help.ts`:
    - `--token <PAT>` 예시 제거 (line 46)
    - `tenant add` 예시를 `gh-symphony tenant add` 만으로 변경
    - non-interactive 예시: `gh-symphony tenant add --non-interactive --project <id>` (--token 없이)
  - `README.md`:
    - "Required classic PAT scopes" 섹션 → "Authentication" 섹션으로 변경
    - gh CLI 설치/인증 안내 추가
    - `gh auth login --scopes repo,read:org,project` 명령어 예시
    - `--non-interactive --token ghp_xxx` 예시 제거
    - `GITHUB_GRAPHQL_TOKEN` env var 폴백 설명 추가 (CI/CD용)
    - "Registering a tenant" 섹션의 PAT 관련 설명 업데이트

  **Must NOT do**:
  - 문서 외 코드 수정 금지
  - 아키텍처/패키지 설명 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: 문서 작성/편집 전용
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 11)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 5, 6, 7

  **References**:

  **Pattern References**:
  - `packages/cli/src/commands/help.ts:3-53` — 전체 HELP_TEXT. Line 46 `--token <PAT>` 교체
  - `README.md` — "Required classic PAT scopes" 섹션, "Registering a tenant" 섹션, non-interactive 예시

  **Acceptance Criteria**:
  - [ ] `help.ts`에 `--token` 문자열 없음
  - [ ] `README.md`에 `--token ghp_xxx` 패턴 없음
  - [ ] `README.md`에 gh CLI 인증 안내 존재
  - [ ] `README.md`에 `GITHUB_GRAPHQL_TOKEN` 폴백 설명 존재

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: help 텍스트에 PAT 언급 없음
    Tool: Bash
    Steps:
      1. grep -i "PAT\|--token" packages/cli/src/commands/help.ts 실행
    Expected Result: 매칭 없음 (exit code 1)
    Evidence: .sisyphus/evidence/task-10-help-no-pat.txt

  Scenario: README에 gh CLI 인증 안내 존재
    Tool: Bash
    Steps:
      1. grep "gh auth login" README.md 실행
    Expected Result: 매칭 존재 — gh auth login 명령어 안내
    Evidence: .sisyphus/evidence/task-10-readme-gh-auth.txt
  ```

  **Commit**: YES
  - Message: `docs: update auth documentation for gh CLI migration`
  - Files: `packages/cli/src/commands/help.ts`, `README.md`
  - Pre-commit: `pnpm lint`

- [x] 11. 전체 빌드 + 테스트 + 타입체크 검증

  **What to do**:
  - 전체 검증 명령어 실행:
    ```bash
    pnpm lint && pnpm test && pnpm typecheck && pnpm build
    ```
  - 실패 시 원인 파악 + 수정
  - 특별히 확인할 사항:
    - 기존 테스트에서 `process.env.GITHUB_GRAPHQL_TOKEN = "test-token"` 사용하는 8+ 파일이 모두 통과
    - `pnpm --filter @gh-symphony/cli test` — init.test.ts, lifecycle.test.ts 등
    - `pnpm --filter @gh-symphony/orchestrator test` — service.test.ts, dispatch.test.ts 등
    - `pnpm --filter @gh-symphony/tracker-github test`
    - typecheck에서 token 관련 타입 에러 없음

  **Must NOT do**:
  - 이 태스크에서 새 기능 추가 금지 — 검증 + 수정만

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 명령어 실행 + 결과 확인
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (after ALL previous tasks)
  - **Blocks**: F1-F4
  - **Blocked By**: ALL tasks (1-10)

  **References**:

  **Test References**:
  - `packages/orchestrator/src/service.test.ts` — `process.env.GITHUB_GRAPHQL_TOKEN` 사용하는 주요 테스트
  - `packages/orchestrator/src/dispatch.test.ts` — token env var 의존
  - `packages/cli/src/commands/init.test.ts` — init 명령어 테스트
  - `packages/cli/src/commands/lifecycle.test.ts` — CLI lifecycle 테스트

  **Acceptance Criteria**:
  - [ ] `pnpm lint` → exit 0
  - [ ] `pnpm test` → exit 0 (all tests pass)
  - [ ] `pnpm typecheck` → exit 0 (no type errors)
  - [ ] `pnpm build` → exit 0 (clean build)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 전체 검증 통과
    Tool: Bash
    Steps:
      1. pnpm lint 실행
      2. pnpm test 실행
      3. pnpm typecheck 실행
      4. pnpm build 실행
    Expected Result: 4개 모두 exit code 0
    Evidence: .sisyphus/evidence/task-11-full-verification.txt

  Scenario: 기존 테스트의 env var 폴백 확인
    Tool: Bash
    Steps:
      1. pnpm --filter @gh-symphony/orchestrator test 실행
      2. service.test.ts, dispatch.test.ts 통과 확인
    Expected Result: process.env.GITHUB_GRAPHQL_TOKEN 기반 테스트 모두 PASS
    Evidence: .sisyphus/evidence/task-11-env-var-compat.txt
  ```

  **Commit**: NO (검증만 — 수정 필요 시 해당 태스크 파일에 커밋)

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
      Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
      Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
      Run `pnpm lint && pnpm test && pnpm typecheck && pnpm build`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify no `token` field remains in config writes.
      Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
      Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (tenant add → start → status). Test edge cases: gh CLI not installed, not authenticated, wrong scopes. Save to `.sisyphus/evidence/final-qa/`.
      Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination. Verify `apps/control-plane/` untouched.
      Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Task | Commit Message                                                                   | Files                           |
| ---- | -------------------------------------------------------------------------------- | ------------------------------- |
| 1    | `feat(cli): add gh-auth module for gh CLI-based authentication`                  | `gh-auth.ts`, `gh-auth.test.ts` |
| 2    | `refactor(cli): remove token field from CliGlobalConfig type`                    | `config.ts`                     |
| 3    | `refactor(tracker-github): remove stored token from resolution chain`            | `orchestrator-adapter.ts`       |
| 4    | `refactor(cli): remove token from writeConfig and tenant config writes`          | `init.ts`                       |
| 5    | `feat(cli): replace PAT prompt with gh CLI auth in tenant add interactive`       | `tenant.ts`                     |
| 6    | `feat(cli): replace --token flag with gh CLI auth in tenant add non-interactive` | `tenant.ts`                     |
| 7    | `feat(cli): replace PAT prompt with gh CLI auth in init command`                 | `init.ts`                       |
| 8    | `refactor(cli): remove token from config show/set commands`                      | `config-cmd.ts`                 |
| 9    | `feat(orchestrator): inject gh-resolved token into worker environment`           | `service.ts`                    |
| 10   | `docs: update auth documentation for gh CLI migration`                           | `help.ts`, `README.md`          |
| 11   | `chore: verify full build passes after gh CLI auth migration`                    | —                               |

---

## Success Criteria

### Verification Commands

```bash
pnpm lint           # Expected: no errors
pnpm test           # Expected: all tests pass
pnpm typecheck      # Expected: no type errors
pnpm build          # Expected: clean build
```

### Final Checklist

- [ ] All "Must Have" present (gh CLI check, scope guidance, env var fallback, broker preserved)
- [ ] All "Must NOT Have" absent (no control-plane changes, no global git config, no broker changes)
- [ ] `config.json`에서 `token` 필드 완전 제거
- [ ] `tenant.json`에서 `tracker.settings.token` 완전 제거
- [ ] 기존 테스트 suite 100% 통과 (env var 폴백으로 테스트 격리 유지)

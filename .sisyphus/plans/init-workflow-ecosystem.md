# Init Workflow Ecosystem Enhancement

## TL;DR

> **Summary**: `gh-symphony init`을 확장하여 최소 WORKFLOW.md 외에 context.yaml (GitHub Project 메타데이터), 6개 에이전트 스킬 (gh-symphony, gh-project, commit, push, pull, land), reference-workflow.md를 자동 생성. CLI는 데이터 수집, AI 에이전트는 워크플로우 설계라는 분업 구조.
> **Deliverables**: context.yaml 생성기, 환경 감지 모듈, 스킬 템플릿 인프라 + 6개 스킬, reference-workflow.md 생성기, 강화된 WORKFLOW.md, init 명령어 통합
> **Effort**: Large
> **Parallel**: YES — 3 waves
> **Critical Path**: Environment Detection → Context.yaml Generator → Init Integration

## Context

### Original Request

OpenAI Elixir Symphony의 WORKFLOW.md (~400줄)를 참고하여, `gh-symphony init`이 사용자의 워크플로우 설계 리소스를 최소화하도록 풍성한 에코시스템을 자동 생성하게 만든다. 현재는 ~15줄짜리 기본 WORKFLOW.md만 생성.

### Interview Summary

| 결정                | 선택                                                             |
| ------------------- | ---------------------------------------------------------------- |
| init 출력물         | context.yaml + skills + 최소 WORKFLOW.md + reference-workflow.md |
| 스킬 granularity    | 단일 `/gh-symphony` (상태 감지 후 질문)                          |
| Reference 소스      | CLI 번들 + 런타임별 변형                                         |
| 템플릿 엔진         | 우회 ({{retry_context}} 패턴), 향후 개선                         |
| GitHub Project 통신 | `/gh-project` 스킬로 init 시 기본 제공                           |
| Related Skills      | commit, push, pull, land — init이 일괄 등록                      |
| Init 재실행         | context.yaml은 덮어쓰기, skills는 존재 시 스킵                   |

### Metis Review (gaps addressed)

1. **Field ID 유실**: `getProjectDetail()` 반환값에서 `option.name`만 추출하고 `.id`를 버림 → context.yaml 생성 시 반드시 ID 플럼빙 필요
2. **Parser 호환성**: 강화된 WORKFLOW.md는 8개 지원 변수만 사용해야 함 (`issue.*` 7개 + `attempt`) — `renderPrompt()` strict mode가 미지원 변수에 throw
3. **YAML 특수문자**: `Won't Do`, `In Progress (Blocked)` 등 → context.yaml 생성 시 quoting 필수
4. **Idempotency**: init 재실행 시 context.yaml 덮어쓰기, skill 파일은 존재 확인 후 스킵
5. **런타임 분기**: 선택된 런타임(codex/claude-code)에 해당하는 스킬 디렉토리만 생성, 양쪽 동시 생성 금지
6. **Scope guard**: CLI가 "풍성한" WORKFLOW.md를 생성하지 않음 — 그건 AI 에이전트의 역할. CLI는 최소+기능 WORKFLOW.md만.

## Work Objectives

### Core Objective

`gh-symphony init` 실행 시 에이전트가 정밀한 워크플로우를 설계할 수 있는 완전한 에코시스템을 자동 생성한다.

### Deliverables

1. `.gh-symphony/context.yaml` — GitHub Project 메타데이터 (field ID, option ID 포함)
2. `.gh-symphony/reference-workflow.md` — 주석 달린 참조 템플릿 (런타임별)
3. `WORKFLOW.md` — 강화된 최소 워크플로우 (즉시 실행 가능)
4. `.claude/skills/` 또는 `.codex/skills/` — 6개 에이전트 스킬
5. 환경 감지 모듈 (패키지 매니저, 테스트 프레임워크, CI)

### Definition of Done (verifiable conditions with commands)

- `pnpm --filter @gh-symphony/cli test` — 모든 테스트 통과
- `pnpm typecheck` — 타입 검사 통과
- `pnpm lint` — 린트 통과
- `pnpm build` — 빌드 성공
- init 실행 시 6개 파일 + 6개 스킬 + WORKFLOW.md + reference-workflow.md 생성 확인

### Must Have

- context.yaml에 field ID, option ID 포함 (GitHub Project mutation에 필요)
- 환경 감지: 패키지 매니저, 테스트 커맨드, CI 플랫폼
- 6개 스킬: gh-symphony, gh-project, commit, push, pull, land
- reference-workflow.md: Elixir WORKFLOW.md 수준의 구조를 GitHub Project 버전으로
- 강화된 WORKFLOW.md: status map + 기본 guardrails + workpad 템플릿
- --skip-skills, --skip-context 플래그 지원
- YAML 특수문자 안전한 quoting
- 스킬 파일 존재 시 덮어쓰기 스킵 (idempotency)

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)

- `packages/core/`, `packages/orchestrator/`, `packages/worker/` 변경 금지
- CLI가 400줄짜리 "풍성한" WORKFLOW.md 직접 생성 금지 — 그건 AI 에이전트의 역할
- context.yaml에 토큰/시크릿 저장 금지 (커밋 가능해야 함)
- 양쪽 런타임 스킬 동시 생성 금지 (선택된 런타임만)
- 새 `{{custom_variable}}` 패턴을 WORKFLOW.md prompt body에 추가 금지 (core PromptVariables 변경 필요하므로 scope 밖)
- 새 템플릿 엔진/라이브러리 도입 금지 — 기존 string array 패턴 사용
- init 중 interactive 스킬 커스터마이즈 금지 — 기본값으로 생성, 사용자가 나중에 수정
- GraphQL mutation 금지 — context.yaml은 에이전트가 사용할 ID 저장용, init이 mutation하지 않음

## Verification Strategy

> ZERO HUMAN INTERVENTION — all verification is agent-executed.

- Test decision: Tests-after (기존 테스트 패턴 따름) — Vitest
- QA policy: 모든 태스크에 agent-executed QA 시나리오 포함
- Evidence: .sisyphus/evidence/task-{N}-{slug}.{ext}
- Round-trip test: generateWorkflowMarkdown → parseWorkflowMarkdown → renderPrompt (strict mode)

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Foundation — 5 parallel tasks):

- Task 1: Environment detection module [quick]
- Task 2: Context.yaml types + generator [quick]
- Task 3: Skill writer infrastructure [quick]
- Task 4: Reference workflow generator [unspecified-low]
- Task 5: Enhanced WORKFLOW.md prompt body [quick]

Wave 2 (Skill Content — 2 parallel tasks, depends on Task 3):

- Task 6: Core skill templates (gh-symphony + gh-project) [unspecified-low]
- Task 7: Workflow skill templates (commit + push + pull + land) [quick]

Wave 3 (Integration — 1 task, depends on all above):

- Task 8: Wire into init command + integration tests [unspecified-high]

### Dependency Matrix

| Task                        | Depends On     | Blocks  |
| --------------------------- | -------------- | ------- |
| 1. Environment detection    | —              | 2, 8    |
| 2. Context.yaml generator   | 1 (types only) | 8       |
| 3. Skill writer infra       | —              | 6, 7, 8 |
| 4. Reference workflow       | —              | 8       |
| 5. Enhanced WORKFLOW.md     | —              | 8       |
| 6. Core skill templates     | 3              | 8       |
| 7. Workflow skill templates | 3              | 8       |
| 8. Init integration         | 1,2,3,4,5,6,7  | F1-F4   |

### Agent Dispatch Summary

| Wave  | Tasks | Categories                        |
| ----- | ----- | --------------------------------- |
| 1     | 5     | quick ×3, unspecified-low ×2      |
| 2     | 2     | unspecified-low ×1, quick ×1      |
| 3     | 1     | unspecified-high ×1               |
| Final | 4     | oracle, unspecified-high ×2, deep |

## TODOs

- [x] 1. Environment Detection Module

  **What to do**:
  `packages/cli/src/detection/environment-detector.ts` 생성. 현재 디렉토리를 스캔하여 프로젝트 환경을 자동 감지하는 모듈.

  감지 대상:
  - 패키지 매니저: `pnpm-lock.yaml` → pnpm, `package-lock.json` → npm, `yarn.lock` → yarn, `bun.lock` / `bun.lockb` → bun
  - 테스트 커맨드: `package.json`의 `scripts.test` 파싱 (없으면 null)
  - 빌드 커맨드: `package.json`의 `scripts.build` 파싱 (없으면 null)
  - 린트 커맨드: `package.json`의 `scripts.lint` 파싱 (없으면 null)
  - CI 플랫폼: `.github/workflows/` 존재 → `github-actions`
  - 모노레포: `pnpm-workspace.yaml` 또는 `lerna.json` 또는 package.json의 `workspaces` 존재
  - 기존 스킬: `.claude/skills/` 또는 `.codex/skills/` 디렉토리 스캔

  출력 타입:

  ```typescript
  type DetectedEnvironment = {
    packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
    lockfile: string | null;
    testCommand: string | null;
    buildCommand: string | null;
    lintCommand: string | null;
    ciPlatform: "github-actions" | null;
    monorepo: boolean;
    existingSkills: string[]; // 기존 스킬 디렉토리 이름 목록
  };
  ```

  파일 시스템 접근은 `fs/promises`의 `access`, `readFile` 사용. 파일 없으면 graceful fallback (null/false).

  **Must NOT do**:
  - 네트워크 요청 금지
  - 디렉토리 트리 전체 탐색 금지 (알려진 경로만 체크)
  - 외부 의존성 추가 금지

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 단일 파일, 파일 존재 여부 체크 로직, ~100줄
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [2, 8] | Blocked By: []

  **References**:
  - Pattern: `packages/cli/src/mapping/smart-defaults.ts:6-21` — regex 패턴 매칭 패턴 참고
  - Pattern: `packages/cli/src/config.ts:136-146` — `readJsonFile` graceful error handling 패턴
  - Type: `packages/cli/package.json` — 의존성 확인 (외부 의존성 추가 금지)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/detection/environment-detector.test.ts` 통과
  - [ ] pnpm 프로젝트에서 `packageManager: "pnpm"` 감지
  - [ ] npm/yarn/bun lockfile별 올바른 감지
  - [ ] lockfile 없는 경우 `packageManager: null`
  - [ ] package.json scripts에서 test/build/lint 커맨드 추출
  - [ ] .github/workflows/ 존재 시 `ciPlatform: "github-actions"`
  - [ ] `pnpm typecheck` 통과 (strict mode)

  **QA Scenarios**:

  ```
  Scenario: pnpm 모노레포 감지
    Tool: Bash
    Steps: temp dir에 pnpm-lock.yaml + pnpm-workspace.yaml + package.json(scripts.test="vitest") 생성 → detectEnvironment() 호출
    Expected: { packageManager: "pnpm", monorepo: true, testCommand: "vitest" }
    Evidence: .sisyphus/evidence/task-1-env-detect.txt

  Scenario: 빈 디렉토리 감지
    Tool: Bash
    Steps: 빈 temp dir에서 detectEnvironment() 호출
    Expected: 모든 필드 null/false/[] — throw 없음
    Evidence: .sisyphus/evidence/task-1-env-detect-empty.txt
  ```

  **Commit**: YES | Message: `feat(cli): add environment detection module` | Files: [packages/cli/src/detection/environment-detector.ts, packages/cli/src/detection/environment-detector.test.ts]

---

- [x] 2. Context.yaml Schema and Generator

  **What to do**:
  `packages/cli/src/context/` 디렉토리에 두 파일 생성:
  1. `context-types.ts` — ContextYaml 타입 정의
  2. `generate-context-yaml.ts` — context.yaml 문자열 생성 + 파일 쓰기

  **타입 정의** (`context-types.ts`):

  ```typescript
  type ContextYaml = {
    schema_version: 1;
    collected_at: string; // ISO 8601
    project: {
      id: string;
      title: string;
      url: string;
    };
    status_field: {
      id: string;
      name: string;
      columns: Array<{
        id: string;
        name: string;
        color: string | null;
        inferred_role: "active" | "wait" | "terminal" | null;
        confidence: "high" | "low";
      }>;
    };
    text_fields: Array<{
      id: string;
      name: string;
      data_type: string;
      inferred_purpose: "blocker" | null;
    }>;
    repositories: Array<{
      owner: string;
      name: string;
      clone_url: string;
    }>;
    detected_environment: DetectedEnvironment; // Task 1의 타입
    runtime: {
      agent: string; // "codex" | "claude-code" | "custom"
      agent_command: string;
    };
  };
  ```

  **생성 함수** (`generate-context-yaml.ts`):
  - 입력: `ProjectDetail` + `StatusFieldOption[]` (ID 포함) + `DetectedEnvironment` + runtime 정보
  - 출력: YAML 문자열 (순수 문자열 빌드, yaml 라이브러리 없음)
  - YAML quoting: 값에 `:`, `#`, `'`, `"`, `[`, `]`, `{`, `}` 포함 시 `"..."` 감싸기
  - 파일 쓰기: `writeContextYaml(outputDir, context)` — `mkdir -p` + atomic write (tmp+rename)
  - 핵심: `getProjectDetail()` 반환값에서 `statusField.id`, `option.id`, `option.color` 를 **그대로 전달** — 현재 `init.ts:176`에서 `option.name`만 추출하는 것과 달리 모든 ID를 보존

  **Must NOT do**:
  - yaml 외부 라이브러리 추가 금지 (기존 core parser도 자체 YAML 파서 사용)
  - 토큰/시크릿을 context.yaml에 포함 금지
  - context.yaml에 `gh-symphony init`이 아닌 다른 명령에서 쓰는 필드 추가 금지

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 타입 정의 + YAML 문자열 빌드, ~150줄
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [8] | Blocked By: [1 (타입 import만)]

  **References**:
  - Pattern: `packages/cli/src/workflow/generate-workflow-md.ts:23-80` — string array 빌드 + join 패턴
  - Pattern: `packages/cli/src/config.ts:148-153` — atomic write (tmp + rename) 패턴
  - API: `packages/cli/src/github/client.ts:28-33` — `StatusFieldOption` 타입 (id, name, color)
  - API: `packages/cli/src/github/client.ts:35-39` — `ProjectStatusField` 타입 (id, name, options)
  - API: `packages/cli/src/github/client.ts:54-61` — `ProjectDetail` 타입 (statusFields, textFields, linkedRepositories)
  - Pattern: `packages/cli/src/mapping/smart-defaults.ts:29-39` — `inferStateRole()` 호출하여 role/confidence 채우기

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/context/generate-context-yaml.test.ts` 통과
  - [ ] 생성된 YAML이 field ID, option ID를 포함
  - [ ] 특수문자 포함 컬럼명 (`Won't Do`, `In Progress (Blocked)`) 안전하게 quoting
  - [ ] 토큰이 출력에 포함되지 않음
  - [ ] `schema_version: 1` 포함
  - [ ] `pnpm typecheck` 통과

  **QA Scenarios**:

  ```
  Scenario: 정상 context.yaml 생성
    Tool: Bash
    Steps: mock ProjectDetail (3 columns, 2 repos, 1 text field) → generateContextYaml() → 파일 읽기 → 구조 검증
    Expected: project.id, status_field.columns[].id, repositories[].clone_url 모두 존재
    Evidence: .sisyphus/evidence/task-2-context-yaml.txt

  Scenario: 특수문자 quoting
    Tool: Bash
    Steps: column name "Won't Do" + "In Progress (Blocked)" → generateContextYaml() → YAML 파싱 검증
    Expected: 값이 double-quote로 감싸짐, 파싱 시 원본 문자열 복원
    Evidence: .sisyphus/evidence/task-2-context-yaml-special.txt
  ```

  **Commit**: YES | Message: `feat(cli): add context.yaml schema and generator` | Files: [packages/cli/src/context/context-types.ts, packages/cli/src/context/generate-context-yaml.ts, packages/cli/src/context/generate-context-yaml.test.ts]

---

- [x] 3. Skill Writer Infrastructure

  **What to do**:
  `packages/cli/src/skills/` 디렉토리에 스킬 파일 쓰기 인프라 생성:
  1. `types.ts` — 스킬 템플릿 타입 정의
  2. `skill-writer.ts` — 스킬 파일을 디스크에 쓰는 유틸리티

  **타입** (`types.ts`):

  ```typescript
  type SkillRuntime = "claude-code" | "codex";

  type SkillTemplate = {
    name: string; // e.g., "gh-symphony"
    fileName: string; // e.g., "SKILL.md" 또는 "gh-symphony.md"
    generate: (context: SkillTemplateContext) => string;
  };

  type SkillTemplateContext = {
    runtime: SkillRuntime;
    projectId: string;
    projectTitle: string;
    repositories: Array<{ owner: string; name: string }>;
    statusColumns: Array<{
      id: string; // option ID (GitHub Project mutation에 필요)
      name: string;
      role: "active" | "wait" | "terminal" | null;
    }>;
    statusFieldId: string; // field ID (GitHub Project mutation에 필요)
    contextYamlPath: string; // 상대 경로
    referenceWorkflowPath: string; // 상대 경로
  };
  ```

  **Note**: `statusColumns`에 `id` 포함 필수 — Task 6의 gh-project 스킬이 Column ID Quick Reference 테이블을 동적 생성하는 데 필요. `statusFieldId`는 `gh project item-edit --field-id` 명령어에 필요.

  **Writer** (`skill-writer.ts`):
  - `resolveSkillsDir(repoRoot, runtime)` → `claude-code` → `.claude/skills/`, `codex` → `.codex/skills/`. `runtime`이 이 두 값이 아닌 경우 (custom 등) `null` 반환 → 호출자가 스킬 생성 스킵 판단.
  - `writeSkillFile(skillsDir, template, context, options?)` → 개별 스킬 파일 쓰기
    - 디렉토리 없으면 `mkdir -p`
    - 파일 존재 시 기본 스킵 (options.overwrite=true면 덮어쓰기)
    - atomic write (tmp + rename)
  - `writeAllSkills(repoRoot, runtime, templates[], context)` → 모든 스킬 일괄 쓰기
    - 반환: `{ written: string[], skipped: string[] }` — 사용자에게 결과 표시용

  **스킬 디렉토리 구조**:

  ```
  .claude/skills/           (claude-code 런타임)
    gh-symphony/SKILL.md
    gh-project/SKILL.md
    commit/SKILL.md
    push/SKILL.md
    pull/SKILL.md
    land/SKILL.md

  .codex/skills/            (codex 런타임)
    gh-symphony/SKILL.md
    gh-project/SKILL.md
    commit/SKILL.md
    push/SKILL.md
    pull/SKILL.md
    land/SKILL.md
  ```

  **Must NOT do**:
  - 양쪽 런타임 디렉토리 동시 생성 금지
  - 기존 스킬 파일 무조건 덮어쓰기 금지 (기본=스킵)
  - 스킬 내용(템플릿)은 이 태스크에서 작성하지 않음 — 인프라만

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 파일 I/O 유틸리티, ~100줄
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [6, 7, 8] | Blocked By: []

  **References**:
  - Pattern: `packages/cli/src/config.ts:148-153` — atomic write 패턴 (tmp + rename)
  - Pattern: `packages/cli/src/config.ts:43-48` — `tenantConfigDir()` 경로 빌드 패턴
  - Test: `packages/cli/src/commands/init.test.ts:11` — `mkdtemp()` temp dir 패턴

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/skills/skill-writer.test.ts` 통과
  - [ ] claude-code 런타임 → `.claude/skills/` 에 파일 생성
  - [ ] codex 런타임 → `.codex/skills/` 에 파일 생성
  - [ ] custom 런타임 → `resolveSkillsDir()` 가 `null` 반환, `writeAllSkills()`가 graceful skip
  - [ ] 기존 파일 존재 시 스킵 + skipped 배열에 포함
  - [ ] overwrite=true 시 덮어쓰기
  - [ ] `pnpm typecheck` 통과

  **QA Scenarios**:

  ```
  Scenario: 스킬 파일 쓰기 (claude-code)
    Tool: Bash
    Steps: temp dir에 mock template으로 writeSkillFile() 호출 (runtime="claude-code")
    Expected: .claude/skills/test-skill/SKILL.md 파일 존재, 내용 일치
    Evidence: .sisyphus/evidence/task-3-skill-write.txt

  Scenario: 기존 파일 스킵
    Tool: Bash
    Steps: 이미 존재하는 스킬 파일 → writeSkillFile() 호출 (overwrite=false)
    Expected: 파일 내용 변경 없음, skipped 배열에 포함
    Evidence: .sisyphus/evidence/task-3-skill-skip.txt
  ```

  **Commit**: YES | Message: `feat(cli): add skill writer infrastructure` | Files: [packages/cli/src/skills/types.ts, packages/cli/src/skills/skill-writer.ts, packages/cli/src/skills/skill-writer.test.ts]

---

- [x] 4. Reference Workflow Generator

  **What to do**:
  `packages/cli/src/workflow/generate-reference-workflow.ts` 생성. Elixir Symphony WORKFLOW.md를 GitHub Project 버전으로 번역한 주석 달린 참조 템플릿을 생성하는 함수.

  **함수 시그니처**:

  ```typescript
  type ReferenceWorkflowInput = {
    runtime: "codex" | "claude-code" | string;
    statusColumns: Array<{
      name: string;
      role: "active" | "wait" | "terminal" | null;
    }>;
    repositories: Array<{ owner: string; name: string }>;
    projectId: string;
    blockedByFieldName?: string;
  };

  function generateReferenceWorkflow(input: ReferenceWorkflowInput): string;
  ```

  **출력 구조** (주석 달린 완전한 WORKFLOW.md 참조):

  ```markdown
  # Reference WORKFLOW.md — gh-symphony

  # 이 파일은 WORKFLOW.md 작성 시 참고용 참조 템플릿입니다.

  # /gh-symphony 스킬을 통해 AI 에이전트가 이 파일을 참고하여 WORKFLOW.md를 설계합니다.

  # 직접 수정하지 마세요.

  ---

  # ═══ FRONT MATTER 필드 참조 ═══

  # 아래는 gh-symphony 파서가 지원하는 모든 front matter 필드입니다.

  github_project_id: {projectId}
  allowed_repositories:

  - {owner}/{name}

  lifecycle:
  state_field: Status
  active_states: [...]
  terminal_states: [...]
  blocker_check_states: [...]

  # blocked_by_field: "Blocked By" # 텍스트 필드명 (선택)

  runtime:
  agent_command: {런타임별 명령어}
  max_turns: 20
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000

  hooks:
  after_create: | # {패키지매니저별 기본 스크립트}
  before_run: null
  after_run: null
  before_remove: null

  scheduler:
  poll_interval_ms: 30000

  retry:
  base_delay_ms: 1000
  max_delay_ms: 30000

  ---

  # ═══ PROMPT BODY 참조 ═══

  # 아래는 Elixir Symphony를 GitHub Project 버전으로 번역한 참조입니다.

  ## Status Map

  {status column별 상세 행동 가이드}

  ## Default Posture

  {13개 행동 원칙}

  ## Related Skills

  {gh-project, commit, push, pull, land 설명}

  ## Step 0: Determine current state and route

  {상태별 라우팅}

  ## Step 1: Start/continue execution

  {실행 셋업, workpad 생성}

  ## Step 2: Execution phase

  {구현, 테스트, PR 생성}

  ## Step 3: Human Review and merge handling

  {리뷰 대기, merge 플로우}

  ## Step 4: Rework handling

  {재작업 정책}

  ## PR Feedback Sweep Protocol

  {PR 피드백 처리}

  ## Completion Bar

  {Human Review 전 체크리스트}

  ## Guardrails

  {안전 규칙}

  ## Workpad Template

  {워크패드 마크다운 구조}
  ```

  런타임별 차이:
  - **codex**: `agent_command: bash -lc codex app-server`, sandbox 설정 코멘트
  - **claude-code**: `agent_command: bash -lc claude-code`, 다른 sandbox 가이드

  **Must NOT do**:
  - 이 파일이 실행 가능한 WORKFLOW.md가 되어선 안 됨 — 참조용
  - `{{template_variable}}` 사용 금지 (이 파일은 렌더링 대상이 아님, 참조 문서)
  - 대신 `{placeholder}` 중괄호 하나로 주석/예시 표시

  **Recommended Agent Profile**:
  - Category: `unspecified-low` — Reason: 큰 문자열 템플릿 작성, 콘텐츠 설계 필요
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [8] | Blocked By: []

  **References**:
  - External: Elixir Symphony WORKFLOW.md — https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md (주요 구조 참고)
  - Pattern: `packages/cli/src/workflow/generate-workflow-md.ts:17-21` — 마크다운 생성 패턴
  - Schema: `packages/core/src/workflow/config.ts:34-48` — ParsedWorkflow/WorkflowDefinition 필드 목록 (지원하는 front matter 필드의 정확한 목록)
  - Schema: `packages/core/src/workflow/parser.ts:63-148` — 파서가 읽는 모든 필드 (front matter 참조의 정확한 소스)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/workflow/generate-reference-workflow.test.ts` 통과
  - [ ] 출력에 모든 지원 front matter 필드가 주석과 함께 포함
  - [ ] codex vs claude-code 런타임별 agent_command 차이 반영
  - [ ] Status Map에 입력된 컬럼별 상세 행동 가이드 포함
  - [ ] `{{...}}` 패턴이 출력에 없음 (이중 중괄호 금지)
  - [ ] `pnpm typecheck` 통과

  **QA Scenarios**:

  ```
  Scenario: codex 런타임 참조 생성
    Tool: Bash
    Steps: 3개 status column + codex 런타임 → generateReferenceWorkflow() → 출력 검증
    Expected: agent_command이 "codex" 포함, 모든 섹션 헤더 존재
    Evidence: .sisyphus/evidence/task-4-ref-workflow-codex.txt

  Scenario: claude-code 런타임 참조 생성
    Tool: Bash
    Steps: 동일 입력 + claude-code 런타임 → 출력 검증
    Expected: agent_command이 "claude-code" 포함, codex와 다른 내용
    Evidence: .sisyphus/evidence/task-4-ref-workflow-claude.txt
  ```

  **Commit**: YES | Message: `feat(cli): add reference workflow generator` | Files: [packages/cli/src/workflow/generate-reference-workflow.ts, packages/cli/src/workflow/generate-reference-workflow.test.ts]

---

- [x] 5. Enhanced WORKFLOW.md Prompt Body

  **What to do**:
  `packages/cli/src/workflow/generate-workflow-md.ts`의 `buildPromptBody()` 함수를 확장하여 현재 6줄짜리 generic instructions를 더 풍성하게 만든다.

  **현재** (`generate-workflow-md.ts:93-115`):

  ```
  ## Status Map
  - **Todo** [active]

  ## Agent Instructions
  You are an AI coding agent working on issue {{issue.identifier}}...
  1. Read the issue description...
  2. Explore the codebase...
  (6단계)
  ```

  **변경 후** (추가 섹션):

  ```markdown
  ## Status Map

  - **Todo** [active] — 에이전트가 즉시 작업 시작
  - **In Progress** [active] — 구현 진행 중
  - **Review** [wait] — PR 생성 완료, 사람 리뷰 대기
  - **Done** [terminal] — 완료, 에이전트 종료

  ## Agent Instructions

  You are an AI coding agent working on issue {{issue.identifier}}: "{{issue.title}}".

  **Repository:** {{issue.repository}}
  **Current state:** {{issue.state}}

  ### Task

  {{issue.description}}

  ### Default Posture

  1. 이것은 무인 오케스트레이션 세션입니다. 사람에게 후속 작업을 요청하지 마세요.
  2. 진짜 블로커(필수 권한/시크릿 누락)일 때만 조기 중단하세요.
  3. 최종 메시지에는 완료된 작업과 블로커만 보고하세요. "다음 단계"를 포함하지 마세요.

  ### Workflow

  1. 이슈 설명을 읽고 요구사항을 이해하세요.
  2. 코드베이스를 탐색하여 관련 코드 구조를 파악하세요.
  3. 프로젝트의 코딩 컨벤션을 따라 변경을 구현하세요.
  4. 변경 사항을 커버하는 테스트를 작성하거나 업데이트하세요.
  5. 모든 기존 테스트가 통과하는지 확인하세요.
  6. 변경 사항에 대한 명확한 설명과 함께 PR을 생성하세요.

  ### Guardrails

  - 이슈 본문을 계획이나 진행 추적 목적으로 수정하지 마세요.
  - terminal 상태인 이슈에 대해서는 아무것도 하지 말고 종료하세요.
  - 범위 밖 개선사항을 발견하면 현재 범위를 확장하지 말고 별도 이슈를 생성하세요.

  ### Workpad Template

  이슈 코멘트에 아래 구조의 워크패드를 생성하여 진행 상황을 추적하세요:

  \`\`\`md

  ## Workpad

  ### Plan

  - [ ] 1. 작업 항목

  ### Acceptance Criteria

  - [ ] 기준 1

  ### Validation

  - [ ] 테스트: `명령어`

  ### Notes

  - 진행 메모
    \`\`\`
  ```

  **핵심 제약**: 사용하는 변수는 반드시 `issue.identifier`, `issue.title`, `issue.repository`, `issue.state`, `issue.description`만 — 이 8개(`issue.*` 7개 + `attempt`)는 `PromptVariables`에 정의된 것만 사용.

  **Must NOT do**:
  - `{{issue.labels}}`, `{{retry_context}}` 등 core에 없는 변수 사용 금지
  - 400줄짜리 Elixir 수준의 상세 워크플로우 생성 금지 — 그건 AI 스킬의 역할
  - 기존 `GenerateWorkflowInput` 타입 변경 최소화

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 기존 함수 확장, 문자열 변경
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [8] | Blocked By: []

  **References**:
  - Pattern: `packages/cli/src/workflow/generate-workflow-md.ts:93-115` — 현재 buildPromptBody() (수정 대상)
  - Pattern: `packages/cli/src/mapping/smart-defaults.ts:134-146` — generateStatusMap() (role별 설명 추가 가능)
  - Test: `packages/cli/src/workflow/generate-workflow-md.test.ts` — 기존 테스트 (backward compat 확인)
  - Constraint: `packages/core/src/workflow/render.ts:9-18` — PromptIssueVariables (사용 가능한 변수 목록)
  - Constraint: `packages/core/src/workflow/render.ts:80-112` — renderPrompt() strict mode (미지원 변수 throw)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/workflow/generate-workflow-md.test.ts` 통과
  - [ ] 기존 테스트 변경 없이 통과 (backward compatibility)
  - [ ] 생성된 WORKFLOW.md → `parseWorkflowMarkdown()` 정상 파싱
  - [ ] 파싱된 promptTemplate → `renderPrompt(template, testVars, { strict: true })` throw 없음
  - [ ] Status Map에 role별 한 줄 설명 포함
  - [ ] Default Posture, Guardrails, Workpad Template 섹션 포함
  - [ ] `pnpm typecheck` 통과

  **QA Scenarios**:

  ```
  Scenario: Round-trip 테스트 (strict mode)
    Tool: Bash
    Steps: generateWorkflowMarkdown(input) → parseWorkflowMarkdown(md) → renderPrompt(parsed.promptTemplate, mockVars, {strict:true})
    Expected: throw 없음, 모든 {{변수}} 치환됨
    Evidence: .sisyphus/evidence/task-5-roundtrip.txt

  Scenario: Backward compatibility
    Tool: Bash
    Steps: 기존 테스트 fixtures로 generateWorkflowMarkdown() → 이전 출력 구조 포함 여부 확인
    Expected: 기존 "Agent Instructions" 섹션 구조 유지
    Evidence: .sisyphus/evidence/task-5-backward-compat.txt
  ```

  **Commit**: YES | Message: `feat(cli): enhance WORKFLOW.md with richer prompt body` | Files: [packages/cli/src/workflow/generate-workflow-md.ts, packages/cli/src/workflow/generate-workflow-md.test.ts]

---

- [x] 6. Core Skill Templates (gh-symphony + gh-project)

  **What to do**:
  `packages/cli/src/skills/templates/` 디렉토리에 두 개의 핵심 스킬 템플릿 생성:

  **6a. `gh-symphony.ts`** — 메인 워크플로우 설계/개선 스킬:

  ```typescript
  export function generateGhSymphonySkill(ctx: SkillTemplateContext): string;
  ```

  스킬 내용:
  - Trigger: 사용자가 WORKFLOW.md를 생성/개선하고 싶을 때
  - Mode detection: WORKFLOW.md 존재 여부로 design/refine 자동 판별 → 사용자에게 질문
  - Context files: `.gh-symphony/context.yaml` (필수), `.gh-symphony/reference-workflow.md` (필수), `WORKFLOW.md` (있으면 refine)
  - Design 모드: context.yaml 읽기 → 레포 구조 분석 → reference-workflow.md 참고 → 사용자에게 핵심 결정 질문 → WORKFLOW.md 생성
  - Refine 모드: 현재 WORKFLOW.md vs reference 비교 → 누락 섹션 식별 → 개선 제안 → 적용
  - Validate 모드: 파서 호환성 체크, 필수 섹션 존재 확인
  - 반드시 포함할 섹션 목록 (Status map, Default posture, Execution flow, PR feedback, Guardrails 등)
  - 지원되는 front matter 필드 목록 (파서 스키마에서 추출)
  - 사용 가능한 template variables 목록 (8개: issue.\* + attempt)
  - Related skills 참조 (gh-project, commit, push, pull, land)

  **6b. `gh-project.ts`** — GitHub Project 통신 스킬:

  ```typescript
  export function generateGhProjectSkill(ctx: SkillTemplateContext): string;
  ```

  스킬 내용:
  - Purpose: GitHub Project v2 보드와 통신하여 이슈 상태 관리
  - Prerequisites: `gh` CLI 인증 완료, `.gh-symphony/context.yaml` 존재
  - Operations:
    - 이슈 상태 변경: `gh project item-edit` 명령어 + context.yaml의 field ID / option ID 참조
    - 워크패드 코멘트: `gh issue comment` 생성, `gh api` PATCH 업데이트
    - 후속 이슈 생성: `gh issue create` 명령어
    - 라벨 관리: `gh issue edit --add-label`
  - Column ID Quick Reference: `ctx.statusColumns`에서 동적 생성 (name → role → option ID 테이블)
  - Rules: WORKFLOW.md의 status map 흐름 준수, terminal state 전이 전 completion bar 확인

  **Must NOT do**:
  - 스킬 내용에 `{{template_variable}}` 사용 금지 (이건 WORKFLOW.md용, 스킬 파일은 정적 마크다운)
  - 스킬 파일에 토큰/시크릿 하드코딩 금지
  - 실제 GraphQL mutation 코드 작성 금지 — `gh` CLI 명령어 예시만
  - 스킬 파일에 Python/JS 코드 블록 금지 — 마크다운 + 쉘 명령 예시만

  **Recommended Agent Profile**:
  - Category: `unspecified-low` — Reason: 콘텐츠 설계 필요, Elixir 참조 번역, ~200줄씩
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [3]

  **References**:
  - External: Elixir Symphony WORKFLOW.md — https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md (Default posture, Status map, Steps 0-4, Guardrails, Workpad template 구조 참고)
  - Type: `packages/cli/src/skills/types.ts` — SkillTemplate, SkillTemplateContext (Task 3에서 생성)
  - Schema: `packages/core/src/workflow/config.ts:34-48` — ParsedWorkflow 필드 목록
  - Schema: `packages/core/src/workflow/render.ts:9-18` — PromptIssueVariables (사용 가능 변수)
  - API: `packages/cli/src/github/client.ts:28-33` — StatusFieldOption 타입 (스킬에서 참조할 ID 구조)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/skills/templates/gh-symphony.test.ts` 통과
  - [ ] `npx vitest run packages/cli/src/skills/templates/gh-project.test.ts` 통과
  - [ ] gh-symphony 스킬에 "Mode detection", "Design 모드", "Refine 모드" 섹션 포함
  - [ ] gh-symphony 스킬에 context.yaml, reference-workflow.md 경로 참조
  - [ ] gh-project 스킬에 `gh project item-edit` 명령어 예시 포함
  - [ ] gh-project 스킬에 context.yaml의 Column ID Quick Reference 테이블 동적 생성
  - [ ] 스킬 출력에 `{{...}}` 이중 중괄호 패턴 없음
  - [ ] `pnpm typecheck` 통과

  **QA Scenarios**:

  ```
  Scenario: gh-symphony 스킬 생성
    Tool: Bash
    Steps: mock context (3 columns, 2 repos) → generateGhSymphonySkill() → 출력 검증
    Expected: "Mode detection", "Design", "Refine", "Related Skills" 섹션 모두 존재
    Evidence: .sisyphus/evidence/task-6-gh-symphony-skill.txt

  Scenario: gh-project 스킬의 Column ID 테이블
    Tool: Bash
    Steps: mock columns with IDs → generateGhProjectSkill() → 테이블 파싱
    Expected: 각 column의 name, role, option_id가 테이블 행으로 존재
    Evidence: .sisyphus/evidence/task-6-gh-project-skill.txt
  ```

  **Commit**: YES | Message: `feat(cli): add core skill templates (gh-symphony, gh-project)` | Files: [packages/cli/src/skills/templates/gh-symphony.ts, packages/cli/src/skills/templates/gh-project.ts, packages/cli/src/skills/templates/gh-symphony.test.ts, packages/cli/src/skills/templates/gh-project.test.ts]

---

- [x] 7. Workflow Skill Templates (commit, push, pull, land)

  **What to do**:
  `packages/cli/src/skills/templates/` 디렉토리에 4개의 워크플로우 스킬 템플릿 생성:

  **7a. `commit.ts`**:
  - 논리적 단위로 커밋 분리
  - Conventional commit 형식: `<type>(<scope>): <description>`
  - types: feat, fix, refactor, test, docs, chore
  - 테스트 깨지는 중간 커밋 금지
  - 임시 디버그 코드 커밋 금지

  **7b. `push.ts`**:
  - 푸시 전 로컬 테스트/린트 통과 확인
  - `git push origin <branch> [-u]`
  - 실패 시: pull → resolve → push 재시도
  - Force push 금지 (--force-with-lease만 허용, 사유 기록)
  - 결과를 workpad에 기록

  **7c. `pull.ts`**:
  - `git fetch origin main` → `git merge origin/main`
  - 충돌 시: 해결 → 테스트 → 커밋
  - pull skill evidence 기록 (source, result, HEAD SHA)
  - 머지 후 테스트 재실행

  **7d. `land.ts`**:
  - PR이 approved 상태인지 확인
  - CI checks 전부 green인지 확인
  - Branch가 base와 up-to-date인지 확인
  - 모두 통과 시 `gh pr merge` (프로젝트 정책에 따라 --squash/--merge/--rebase)
  - 머지 성공 → 이슈 상태 Done 전이 (gh-project 스킬 참조)
  - 머지 실패 → workpad 기록 + 재시도
  - `gh pr merge` 직접 호출 대신 이 스킬의 플로우를 따르도록 안내

  **7e. `index.ts`** — barrel export:

  ```typescript
  export { generateCommitSkill } from "./commit.js";
  export { generatePushSkill } from "./push.js";
  export { generatePullSkill } from "./pull.js";
  export { generateLandSkill } from "./land.js";
  export { generateGhSymphonySkill } from "./gh-symphony.js";
  export { generateGhProjectSkill } from "./gh-project.js";

  export const ALL_SKILL_TEMPLATES: SkillTemplate[] = [...];
  ```

  각 함수 시그니처: `(ctx: SkillTemplateContext) => string`
  이 4개 스킬은 context-independent (프로젝트 메타데이터에 의존하지 않는 범용 스킬이지만, SkillTemplateContext를 받아 runtime 정보 등을 활용할 수 있음).

  **Must NOT do**:
  - 프로젝트 특화 로직 금지 (이 4개는 범용 스킬)
  - 실행 가능한 스크립트 생성 금지 — 마크다운 가이드만
  - gh-project 스킬의 역할(상태 전이) 중복 금지 — land에서는 "gh-project 스킬 참조"로 위임

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 4개 모두 비교적 짧은 마크다운 템플릿 (~50줄씩)
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [3]

  **References**:
  - External: Elixir Symphony WORKFLOW.md "Related skills" 섹션 — commit, push, pull, land 스킬 참조
  - Type: `packages/cli/src/skills/types.ts` — SkillTemplate, SkillTemplateContext (Task 3)
  - Pattern: `packages/cli/src/skills/templates/gh-symphony.ts` — 동일 디렉토리의 형제 스킬 (Task 6)

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/skills/templates/commit.test.ts` 통과
  - [ ] `npx vitest run packages/cli/src/skills/templates/push.test.ts` 통과
  - [ ] `npx vitest run packages/cli/src/skills/templates/pull.test.ts` 통과
  - [ ] `npx vitest run packages/cli/src/skills/templates/land.test.ts` 통과
  - [ ] 각 스킬에 "## Flow" 또는 "## Rules" 섹션 포함
  - [ ] land 스킬이 "gh-project 스킬 참조"로 상태 전이 위임
  - [ ] barrel export `ALL_SKILL_TEMPLATES`에 6개 모두 포함
  - [ ] `pnpm typecheck` 통과

  **QA Scenarios**:

  ```
  Scenario: 전체 스킬 생성 + barrel export
    Tool: Bash
    Steps: ALL_SKILL_TEMPLATES.map(t => t.generate(mockCtx)) → 6개 출력 검증
    Expected: 6개 스킬 모두 비어있지 않은 마크다운 문자열 반환
    Evidence: .sisyphus/evidence/task-7-all-skills.txt

  Scenario: land 스킬 gh-project 참조
    Tool: Bash
    Steps: generateLandSkill(mockCtx) → "gh-project" 문자열 존재 확인
    Expected: "gh-project" 스킬 참조 포함
    Evidence: .sisyphus/evidence/task-7-land-ref.txt
  ```

  **Commit**: YES | Message: `feat(cli): add workflow skill templates (commit, push, pull, land)` | Files: [packages/cli/src/skills/templates/commit.ts, packages/cli/src/skills/templates/push.ts, packages/cli/src/skills/templates/pull.ts, packages/cli/src/skills/templates/land.ts, packages/cli/src/skills/templates/index.ts, packages/cli/src/skills/templates/*.test.ts]

---

- [x] 8. Wire Workflow Ecosystem into Init Command

  **What to do**:
  `packages/cli/src/commands/init.ts`를 수정하여 Task 1-7의 모듈을 통합. init 실행 시 전체 에코시스템을 생성하도록 배선.

  **변경 사항**:

  **8a. 새 플래그 추가** (`parseInitFlags`):

  ```typescript
  type InitFlags = {
    nonInteractive: boolean;
    token?: string;
    project?: string;
    output?: string;
    skipSkills: boolean; // NEW
    skipContext: boolean; // NEW
  };
  ```

  `--skip-skills`: 스킬 파일 생성 스킵
  `--skip-context`: context.yaml 생성 스킵

  **런타임과 스킬 생성 규칙**:
  - `codex` → `.codex/skills/`에 6개 스킬 생성
  - `claude-code` → `.claude/skills/`에 6개 스킬 생성
  - `custom` → 스킬 생성 스킵 (알려진 스킬 디렉토리 없음). context.yaml + reference-workflow.md는 생성.

  **8b. `runNonInteractive()` 확장**:
  기존 WORKFLOW.md 생성 후 추가:
  1. `detectEnvironment(cwd)` 호출 → 환경 감지
  2. `generateContextYaml(projectDetail, statusField, env, runtime)` → `.gh-symphony/context.yaml` 쓰기
  3. `generateReferenceWorkflow(input)` → `.gh-symphony/reference-workflow.md` 쓰기
  4. `writeAllSkills(cwd, runtime, ALL_SKILL_TEMPLATES, context)` → 스킬 파일 쓰기
  5. 결과 출력: 생성된 파일 목록 + 스킵된 스킬 목록

  **8c. `runInteractiveStandalone()` 확장**:
  기존 Step 4 후, WORKFLOW.md 쓰기 전에:
  1. 런타임 선택 프롬프트 추가 (codex/claude-code/custom) — `tenant add`의 `tenantAddInteractive()` (tenant.ts:401-420)와 동일한 패턴. custom 선택 시 `p.text()`로 커스텀 명령어 입력받음.
  2. 런타임 값 흐름:
     - `runtime` (string: "codex" | "claude-code" | "custom") → WORKFLOW.md 생성의 `runtime` 필드에 전달 → `resolveAgentCommand(runtime)` 또는 custom 명령어 사용
     - `runtime` → context.yaml의 `runtime.agent` 필드에 저장. custom인 경우 `runtime.agent: "custom"`, `runtime.agent_command: "사용자가 입력한 명령어"`
     - `runtime` → `resolveSkillsDir(cwd, runtime)`: codex/claude-code면 스킬 생성, custom이면 null 반환 → 스킬 생성 스킵, `p.log.warn("Custom 런타임은 스킬 자동 생성을 지원하지 않습니다.")`
  3. 환경 감지 → context.yaml → reference-workflow.md → 스킬 쓰기
  4. outro 메시지 업데이트: 생성된 파일 목록 안내

  **8d. `runInteractiveFromTenant()` 확장**:
  기존 WORKFLOW.md 생성 후:
  1. tenant config에서 runtime 추출
  2. 나머지 동일 (context.yaml + reference + skills)

  **8e. `writeConfig()` 변경 없음** (scope 한정):
  `writeConfig()`은 `tenant.ts`에서도 import되며 `configDir` (테넌트 설정 디렉토리)만 받는다. 에코시스템 파일 (context.yaml, skills, reference-workflow.md)은 **레포 루트**에 쓰여야 하므로, `writeConfig()`에는 추가하지 않는다.
  대신 `runNonInteractive()`, `runInteractiveStandalone()`, `runInteractiveFromTenant()` 각 함수에 직접 에코시스템 생성 로직을 추가한다. 레포 루트는 `process.cwd()` (init은 항상 레포 내에서 실행하는 것이 전제). `tenant add`에서는 에코시스템 파일을 생성하지 않는다 — 그건 `init`의 역할.

  **Field ID 플럼빙** (Metis 지적):
  현재 `init.ts:176`에서 `statusField.options.map(o => o.name)`으로 이름만 추출.
  → `statusField` 전체 객체 (`ProjectStatusField` with `.id`, `.options[].id`)를 context.yaml 생성기에 전달.

  **Idempotency 처리**:
  - `.gh-symphony/context.yaml`: 항상 덮어쓰기 (최신 프로젝트 데이터 반영)
  - `.gh-symphony/reference-workflow.md`: 항상 덮어쓰기
  - `WORKFLOW.md`: 기존 init 동작 유지 (항상 덮어쓰기)
  - 스킬 파일: 존재 시 스킵 (skill-writer의 기본 동작)

  **Must NOT do**:
  - 기존 init 플로우의 핵심 동작 변경 금지 (WORKFLOW.md 생성은 그대로)
  - tenant.ts의 import 경로 변경 금지 (writeConfig, generateTenantId, abortIfCancelled)
  - 기존 테스트 삭제 금지 — 확장만

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 기존 코드 수정, 다수 모듈 통합, 기존 테스트와의 호환성 보장
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — 브라우저 불필요

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1-F4] | Blocked By: [1, 2, 3, 4, 5, 6, 7]

  **References**:
  - Modify: `packages/cli/src/commands/init.ts:60-86` — parseInitFlags (새 플래그 추가)
  - Modify: `packages/cli/src/commands/init.ts:108-224` — runNonInteractive (에코시스템 생성 추가)
  - Modify: `packages/cli/src/commands/init.ts:325-503` — runInteractiveStandalone (런타임 프롬프트 + 에코시스템)
  - Modify: `packages/cli/src/commands/init.ts:244-321` — runInteractiveFromTenant (에코시스템 추가)
  - Note: `writeConfig()` (init.ts:570-647)는 수정하지 않음 — tenant.ts에서도 사용되며, 에코시스템은 init 전용
  - Import: `packages/cli/src/detection/environment-detector.ts` — detectEnvironment (Task 1)
  - Import: `packages/cli/src/context/generate-context-yaml.ts` — generateContextYaml, writeContextYaml (Task 2)
  - Import: `packages/cli/src/workflow/generate-reference-workflow.ts` — generateReferenceWorkflow (Task 4)
  - Import: `packages/cli/src/skills/templates/index.ts` — ALL_SKILL_TEMPLATES (Task 7)
  - Import: `packages/cli/src/skills/skill-writer.ts` — writeAllSkills (Task 3)
  - Test: `packages/cli/src/commands/init.test.ts` — 기존 3개 테스트 유지 + 새 통합 테스트 추가

  **Acceptance Criteria**:
  - [ ] `npx vitest run packages/cli/src/commands/init.test.ts` 통과 (기존 + 신규)
  - [ ] 기존 3개 테스트 변경 없이 통과
  - [ ] non-interactive init 실행 → context.yaml + reference-workflow.md + 6 스킬 + WORKFLOW.md 생성
  - [ ] `--skip-skills` 플래그 → 스킬 파일 미생성, 나머지는 생성
  - [ ] `--skip-context` 플래그 → context.yaml 미생성, 나머지는 생성
  - [ ] context.yaml에 statusField.id, option.id 포함 (field ID 플럼빙 확인)
  - [ ] 기존 스킬 파일 존재 시 스킵 (재실행 idempotency)
  - [ ] `pnpm --filter @gh-symphony/cli test` 전체 통과
  - [ ] `pnpm typecheck && pnpm lint && pnpm build` 통과

  **QA Scenarios**:

  ```
  Scenario: 전체 에코시스템 생성 (non-interactive)
    Tool: Bash
    Steps: temp configDir + temp repoDir → runNonInteractive(flags, options) with mock fetch
    Expected: repoDir에 WORKFLOW.md, .gh-symphony/context.yaml, .gh-symphony/reference-workflow.md 존재. .claude/skills/ 또는 .codex/skills/에 6개 스킬 존재.
    Evidence: .sisyphus/evidence/task-8-full-ecosystem.txt

  Scenario: --skip-skills 플래그
    Tool: Bash
    Steps: --skip-skills 추가하여 실행
    Expected: 스킬 디렉토리 미생성, context.yaml과 WORKFLOW.md는 생성
    Evidence: .sisyphus/evidence/task-8-skip-skills.txt

  Scenario: 재실행 idempotency
    Tool: Bash
    Steps: 에코시스템 생성 → 스킬 파일 하나 수정 → init 재실행
    Expected: context.yaml 갱신됨, 수정된 스킬 파일 보존됨 (덮어쓰기 안 됨)
    Evidence: .sisyphus/evidence/task-8-idempotency.txt

  Scenario: field ID 플럼빙
    Tool: Bash
    Steps: mock ProjectDetail with field IDs → init → context.yaml 파싱 → ID 존재 확인
    Expected: status_field.id, status_field.columns[].id 모두 비어있지 않음
    Evidence: .sisyphus/evidence/task-8-field-ids.txt
  ```

  **Commit**: YES | Message: `feat(cli): wire workflow ecosystem into init command` | Files: [packages/cli/src/commands/init.ts, packages/cli/src/commands/init.test.ts]

## Final Verification Wave (4 parallel agents, ALL must APPROVE)

- [x] F1. Plan Compliance Audit — oracle

  **What to do**: Must NOT Have 규칙 준수 검증
  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 전체 코드베이스 스캔 필요
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: core/orchestrator/worker 패키지 무변경 확인
    Tool: Bash
    Steps: git diff --name-only HEAD~8..HEAD | grep -E '^packages/(core|orchestrator|worker)/'
    Expected: 출력 없음 (0 lines)
    Evidence: .sisyphus/evidence/f1-no-core-changes.txt

  Scenario: 새 {{variable}} 패턴 없음 확인
    Tool: ast-grep
    Steps: ast_grep_search(pattern="renderPrompt($TEMPLATE, $VARS)", lang="typescript") → PromptVariables 타입과 대조
    Expected: renderPrompt 호출에서 사용하는 변수가 기존 8개(issue.* + attempt)만
    Evidence: .sisyphus/evidence/f1-no-new-vars.txt

  Scenario: context.yaml에 토큰 미포함
    Tool: Bash (grep)
    Steps: grep -ri "token\|secret\|password\|ghp_\|gho_" packages/cli/src/context/
    Expected: context.yaml 생성 코드에 토큰 관련 값 쓰기 없음
    Evidence: .sisyphus/evidence/f1-no-secrets.txt
  ```

- [x] F2. Code Quality Review — unspecified-high

  **What to do**: 코드 품질 + 기존 패턴 일관성 검증
  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 전체 CLI 패키지 품질 검증
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: TypeScript + Lint + Build
    Tool: Bash
    Steps: pnpm typecheck && pnpm lint && pnpm build
    Expected: exit code 0, 에러 없음
    Evidence: .sisyphus/evidence/f2-build-pass.txt

  Scenario: 전체 테스트 스위트
    Tool: Bash
    Steps: pnpm --filter @gh-symphony/cli test
    Expected: 모든 테스트 통과 (기존 + 신규)
    Evidence: .sisyphus/evidence/f2-test-pass.txt

  Scenario: atomic write 패턴 준수
    Tool: ast-grep
    Steps: 새 파일에서 writeFile 호출 검색 → tmp+rename 패턴 사용 여부 확인
    Expected: 직접 writeFile(최종경로) 없음 — 모두 tmp+rename 또는 기존 유틸리티 사용
    Evidence: .sisyphus/evidence/f2-atomic-write.txt
  ```

- [x] F3. Integration QA — unspecified-high

  **What to do**: 실제 init 실행 시뮬레이션으로 전체 에코시스템 검증
  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 통합 테스트 수준의 검증
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: 전체 에코시스템 파일 존재 확인
    Tool: Bash
    Steps: npx vitest run packages/cli/src/commands/init.test.ts → 통합 테스트가 생성한 temp dir의 파일 트리 검증
    Expected: WORKFLOW.md, .gh-symphony/context.yaml, .gh-symphony/reference-workflow.md, .claude/skills/ 또는 .codex/skills/ 하위 6개 디렉토리 존재
    Evidence: .sisyphus/evidence/f3-ecosystem-files.txt

  Scenario: WORKFLOW.md round-trip (strict mode)
    Tool: Bash
    Steps: 생성된 WORKFLOW.md를 parseWorkflowMarkdown() → renderPrompt(promptTemplate, mockVars, {strict:true}) 호출하는 테스트 실행
    Expected: throw 없음
    Evidence: .sisyphus/evidence/f3-roundtrip.txt

  Scenario: idempotency 검증
    Tool: Bash
    Steps: init 2회 실행 → 두 번째 실행 후 스킬 파일 내용이 첫 번째와 동일한지 (덮어쓰기 안 됨)
    Expected: skipped 배열에 6개 스킬 포함
    Evidence: .sisyphus/evidence/f3-idempotency.txt
  ```

- [x] F4. Scope Fidelity Check — deep

  **What to do**: 브레인스토밍 세션 결정사항이 구현에 정확히 반영되었는지 검증
  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 요구사항 대비 구현 매핑 검증
  - Skills: [] | Omitted: [`playwright`]

  **QA Scenarios**:

  ```
  Scenario: 런타임별 스킬 디렉토리 분리
    Tool: Bash
    Steps: codex 런타임으로 init → .codex/skills/ 존재 + .claude/skills/ 미존재 확인. claude-code로 init → 반대 확인.
    Expected: 선택된 런타임의 디렉토리만 존재
    Evidence: .sisyphus/evidence/f4-runtime-separation.txt

  Scenario: context.yaml field ID 포함
    Tool: Bash
    Steps: 생성된 context.yaml에서 status_field.id, status_field.columns[].id 값 추출
    Expected: 모든 ID가 비어있지 않은 문자열
    Evidence: .sisyphus/evidence/f4-field-ids.txt

  Scenario: custom 런타임 스킬 스킵
    Tool: Bash
    Steps: custom 런타임으로 init → 스킬 디렉토리 미존재 확인 + context.yaml은 존재 확인
    Expected: .claude/skills/ 와 .codex/skills/ 모두 미존재, .gh-symphony/context.yaml 존재
    Evidence: .sisyphus/evidence/f4-custom-skip.txt
  ```

## Commit Strategy

```
Commit 1: feat(cli): add environment detection module
Commit 2: feat(cli): add context.yaml schema and generator
Commit 3: feat(cli): add skill writer infrastructure
Commit 4: feat(cli): add reference workflow generator
Commit 5: feat(cli): enhance WORKFLOW.md with richer prompt body
Commit 6: feat(cli): add core skill templates (gh-symphony, gh-project)
Commit 7: feat(cli): add workflow skill templates (commit, push, pull, land)
Commit 8: feat(cli): wire workflow ecosystem into init command
```

## Success Criteria

- init 실행 시 모든 에코시스템 파일 생성 (context.yaml, reference-workflow.md, WORKFLOW.md, 6 skills)
- 생성된 WORKFLOW.md가 core parser로 정상 파싱
- 생성된 WORKFLOW.md가 renderPrompt strict mode 통과
- context.yaml에 field ID + option ID 포함
- 환경 감지: pnpm/npm/yarn/bun 구분 + 테스트 명령 추출
- 스킬 파일이 런타임별 올바른 디렉토리에 생성
- init 재실행 시 idempotent (context.yaml 갱신, skills 보존)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 전부 통과

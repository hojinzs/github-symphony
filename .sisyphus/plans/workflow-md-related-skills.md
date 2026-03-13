# WORKFLOW.md Related Skills Section

## TL;DR

> **Summary**: init으로 WORKFLOW.md 생성 시, 등록된 `.codex/skills`의 메타데이터(이름 + 설명 + 언제 사용)를 `## Related Skills` 섹션으로 동적 생성하여 포함
> **Deliverables**: SkillTemplate 타입 확장, Related Skills 섹션 생성기, init 연동, 테스트
> **Effort**: Short
> **Parallel**: YES - 2 waves
> **Critical Path**: Task 1 (type extension) → Task 2 (generator + tests) → Task 3 (wiring)

## Context

### Original Request

init으로 WORKFLOW.md 생성 시, `.codex/skills` 등록 후 등록한 스킬을 언제 어디에 써야하는지 Related Skills 도 등록이 필요.

### Interview Summary

- **동적 생성**: `SkillTemplate` 타입에 `description` + `trigger` 필드 추가하여 `ALL_SKILL_TEMPLATES`에서 자동 생성
- **상세도**: 이름 + 설명 + 언제 사용하는지 (3-part format)
- **위치**: Status Map 바로 뒤, Agent Instructions 앞

### Metis Review (gaps addressed)

- **4 call sites**: `generateWorkflowMarkdown()` 호출이 3곳이 아닌 4곳 (writeConfig 포함) → `relatedSkills`를 optional로 처리
- **gh-symphony 제외**: reference-workflow.ts와 동일하게 메타 스킬 제외 → 에이전트용 5개만 포함
- **description 중복 위험**: `SkillTemplate.description`과 `renderSkillDocument()` 내 description이 이중 관리 → 현 스코프에서는 허용, 추후 리팩토링 가능
- **빈 배열 처리**: `relatedSkills`가 `undefined` 또는 `[]`이면 섹션 미출력
- **buildPromptBody 시그니처**: 두 번째 파라미터로 `relatedSkills` 추가 필요
- **test mock 업데이트**: `SkillTemplate` required 필드 추가로 기존 테스트 mock 수정 필요
- **Korean 언어**: 기존 WORKFLOW.md body가 한국어이므로 Related Skills도 한국어로 통일

## Work Objectives

### Core Objective

`generateWorkflowMarkdown()`이 생성하는 WORKFLOW.md에 등록된 스킬 목록을 `## Related Skills` 섹션으로 포함시켜, AI 에이전트가 사용 가능한 스킬과 사용 시점을 인지하도록 함.

### Deliverables

- `SkillTemplate` 타입에 `description`, `trigger` 필드 추가
- `ALL_SKILL_TEMPLATES` 6개 엔트리에 메타데이터 추가
- `generateWorkflowMarkdown()`에 `relatedSkills` 파라미터 추가 및 섹션 생성
- 모든 init 경로에서 스킬 메타데이터 전달
- 테스트 커버리지

### Definition of Done (verifiable conditions with commands)

- `pnpm --filter @gh-symphony/cli test` 통과
- `pnpm typecheck` 통과
- `pnpm lint` 통과
- `pnpm build` 통과
- 생성된 WORKFLOW.md에 `## Related Skills` 섹션 존재 (relatedSkills 전달 시)
- `relatedSkills` 미전달 시 섹션 미출력 (하위 호환)

### Must Have

- `SkillTemplate` 타입에 `description: string` + `trigger: string` 필드 (required)
- `GenerateWorkflowInput`에 `relatedSkills?: Array<{name: string; description: string; trigger: string}>` 필드
- `## Related Skills` 섹션이 `## Status Map` 뒤, `## Agent Instructions` 앞에 위치
- 각 항목 포맷: `- **{name}**: {description} — *{trigger}*`
- gh-symphony 스킬은 Related Skills에서 제외 (에이전트 작업용 스킬만 포함)
- `relatedSkills`가 undefined/[] 이면 섹션 미출력
- `parseWorkflowMarkdown()` + `renderPrompt(strict: true)` 라운드트립 정상 동작

### Must NOT Have (guardrails)

- 개별 스킬 생성기 파일 수정 금지 (commit.ts, push.ts, pull.ts, land.ts, gh-project.ts, gh-symphony.ts)
- `renderSkillDocument()` 수정 금지
- `reference-workflow.ts` 수정 금지
- `tenant.ts` 수정 금지
- core 패키지 수정 금지 (parser.ts, lifecycle.ts 등)
- front matter에 skills 관련 필드 추가 금지

## Verification Strategy

> ZERO HUMAN INTERVENTION — all verification is agent-executed.

- Test decision: tests-after (기존 테스트 확장) + Vitest
- QA policy: 모든 task에 agent-executed 시나리오
- Evidence: .sisyphus/evidence/task-{N}-{slug}.{ext}

## Execution Strategy

### Parallel Execution Waves

Wave 1: [Foundation — type extension + tests]

- Task 1: SkillTemplate 타입 확장 + ALL_SKILL_TEMPLATES 메타데이터 (quick)
- Task 2: Related Skills 섹션 생성기 + 테스트 (quick)

Wave 2: [Wiring — init 연동]

- Task 3: init.ts 전체 call site 연동 (quick)

Wave 3: [Verification]

- F1-F4: Final verification

### Dependency Matrix

| Task | Blocks | Blocked By |
| ---- | ------ | ---------- |
| 1    | 2, 3   | —          |
| 2    | 3      | 1          |
| 3    | F1-F4  | 1, 2       |

### Agent Dispatch Summary

| Wave | Tasks | Categories         |
| ---- | ----- | ------------------ |
| 1    | 2     | quick, quick       |
| 2    | 1     | quick              |
| 3    | 4     | Final verification |

## TODOs

- [ ] 1. SkillTemplate 타입 확장 및 ALL_SKILL_TEMPLATES 메타데이터 추가

  **What to do**:
  1. `packages/cli/src/skills/types.ts`의 `SkillTemplate` 타입에 `description: string`과 `trigger: string` 필드 추가
  2. `packages/cli/src/skills/templates/index.ts`의 `ALL_SKILL_TEMPLATES` 배열에 6개 모두 description + trigger 값 추가
  3. `packages/cli/src/skills/skill-writer.test.ts`의 mock SkillTemplate 객체에 새 필드 추가
  4. TypeCheck 통과 확인

  **Must NOT do**:
  - 개별 스킬 생성기 파일 (commit.ts 등) 수정
  - renderSkillDocument() 수정
  - 기존 SkillTemplate의 name/fileName/generate 필드 변경

  **Recommended Agent Profile**:
  - Category: `quick` — 타입 정의 + 상수 값 추가만으로 구성된 단순 변경
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — UI 작업 없음

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3] | Blocked By: []

  **References**:
  - Type: `packages/cli/src/skills/types.ts:18-22` — `SkillTemplate` 현재 타입 정의
  - Template array: `packages/cli/src/skills/templates/index.ts:16-31` — `ALL_SKILL_TEMPLATES` 배열
  - Test mock: `packages/cli/src/skills/skill-writer.test.ts` — SkillTemplate mock 객체 위치
  - Skill descriptions (참고용, 수정 대상 아님):
    - `packages/cli/src/skills/templates/gh-symphony.ts:148-149` — `"Design, refine, and validate repository WORKFLOW.md files for GitHub Symphony projects."`
    - `packages/cli/src/skills/templates/gh-project.ts:112-114` — `"Manage GitHub Project v2 issue states, workpad comments, and related follow-up actions."`
    - `packages/cli/src/skills/templates/commit.ts:48-49` — `"Create clean, logically scoped commits that keep the repository in a shippable state."`
    - `packages/cli/src/skills/templates/push.ts:41-42` — `"Publish verified local commits to the remote branch without unsafe force pushes."`
    - `packages/cli/src/skills/templates/pull.ts:48-49` — `"Sync the current branch with the latest remote base before implementation or review handoff."`
    - `packages/cli/src/skills/templates/land.ts:74-75` — `"Merge approved pull requests safely after verifying approvals, CI, and branch freshness."`

  **SkillTemplate 메타데이터 값** (한국어, reference-workflow.ts 스타일):

  ```
  gh-symphony:
    description: "WORKFLOW.md 설계, 개선, 검증"
    trigger: "WORKFLOW.md를 새로 만들거나 수정할 때"

  gh-project:
    description: "GitHub Project v2 이슈 상태 관리 및 필드 업데이트"
    trigger: "이슈 상태 전이, 워크패드 생성, 후속 이슈 생성 시"

  commit:
    description: "논리적 단위 커밋 생성 (conventional commit 형식)"
    trigger: "구현 중 변경사항을 커밋할 때"

  push:
    description: "브랜치 푸시 및 원격 저장소 동기화"
    trigger: "로컬 커밋을 원격 브랜치에 게시할 때"

  pull:
    description: "최신 변경사항 가져오기 및 충돌 해결"
    trigger: "작업 시작 전 또는 PR 생성 전 브랜치 동기화 시"

  land:
    description: "PR 머지 및 이슈 완료 처리"
    trigger: "PR이 승인되어 머지가 필요할 때"
  ```

  **Acceptance Criteria** (agent-executable only):
  - [ ] `pnpm typecheck` 통과 (SkillTemplate 필드 추가 후 모든 사용처 호환)
  - [ ] `pnpm --filter @gh-symphony/cli test` 통과 (기존 테스트 깨지지 않음)
  - [ ] `ALL_SKILL_TEMPLATES`의 6개 엔트리 모두 `description`과 `trigger` 값 보유

  **QA Scenarios** (MANDATORY):

  ```
  Scenario: TypeCheck passes after SkillTemplate extension
    Tool: Bash
    Steps: pnpm typecheck
    Expected: Exit code 0, no errors related to SkillTemplate
    Evidence: .sisyphus/evidence/task-1-typecheck.txt

  Scenario: Existing skill-writer tests still pass
    Tool: Bash
    Steps: pnpm --filter @gh-symphony/cli test -- --reporter=verbose packages/cli/src/skills/skill-writer.test.ts
    Expected: All existing tests pass, no regressions
    Evidence: .sisyphus/evidence/task-1-skill-writer-tests.txt
  ```

  **Commit**: YES | Message: `feat(cli): add description and trigger fields to SkillTemplate type` | Files: [packages/cli/src/skills/types.ts, packages/cli/src/skills/templates/index.ts, packages/cli/src/skills/skill-writer.test.ts]

- [ ] 2. Related Skills 섹션 생성기 구현 및 테스트

  **What to do**:
  1. `packages/cli/src/workflow/generate-workflow-md.ts`의 `GenerateWorkflowInput`에 `relatedSkills?: Array<{name: string; description: string; trigger: string}>` 추가
  2. `buildRelatedSkillsSection(skills)` 함수 구현:
     - skills가 undefined 또는 빈 배열이면 빈 문자열 반환
     - `## Related Skills\n\n` 헤더 + 각 스킬별 `- **{name}**: {description} — *{trigger}*` 형식
  3. `buildPromptBody()` 시그니처를 `(mappings, relatedSkills?)` 로 확장
  4. Status Map과 Agent Instructions 사이에 Related Skills 섹션 삽입
  5. `generateWorkflowMarkdown()`에서 `input.relatedSkills`를 `buildPromptBody()`에 전달
  6. `generate-workflow-md.test.ts`에 테스트 추가

  **Must NOT do**:
  - front matter에 skills 관련 필드 추가
  - parser.ts (core) 수정
  - reference-workflow.ts 수정
  - 기존 테스트 수정 (새 테스트만 추가)

  **Recommended Agent Profile**:
  - Category: `quick` — 단일 파일 함수 추가 + 테스트
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — UI 작업 없음

  **Parallelization**: Can Parallel: NO | Wave 1 (after Task 1) | Blocks: [3] | Blocked By: [1]

  **References**:
  - Generator: `packages/cli/src/workflow/generate-workflow-md.ts:4-18` — `GenerateWorkflowInput` 타입 + `generateWorkflowMarkdown()` 함수
  - buildPromptBody: `packages/cli/src/workflow/generate-workflow-md.ts:88-149` — 현재 프롬프트 바디 빌더
  - Status Map builder: `packages/cli/src/workflow/generate-workflow-md.ts:151-172` — 상태맵 빌더 패턴 참고
  - Reference pattern: `packages/cli/src/workflow/generate-reference-workflow.ts:170-179` — 참조용 Related Skills 섹션 형식
  - Test file: `packages/cli/src/workflow/generate-workflow-md.test.ts:1-179` — 기존 테스트 패턴
  - Test fixture: `packages/cli/src/workflow/generate-workflow-md.test.ts:6-22` — `defaultInput` 테스트 데이터

  **구현 세부사항**:
  - `buildPromptBody()` 현재 구조: 템플릿 리터럴로 `${statusMap}\n\n## Agent Instructions\n\n...` 형식
  - 삽입 위치: `${statusMap}` 뒤, `\n\n## Agent Instructions` 앞
  - Related Skills가 있을 때: `${statusMap}\n\n${relatedSkillsSection}\n\n## Agent Instructions\n\n...`
  - Related Skills가 없을 때: `${statusMap}\n\n## Agent Instructions\n\n...` (기존과 동일)

  **Acceptance Criteria** (agent-executable only):
  - [ ] relatedSkills 전달 시 `## Related Skills` 섹션이 출력에 포함됨
  - [ ] relatedSkills 미전달(undefined) 시 `## Related Skills` 미출력
  - [ ] relatedSkills가 빈 배열([]) 시 `## Related Skills` 미출력
  - [ ] `## Related Skills`이 `## Status Map` 뒤, `## Agent Instructions` 앞에 위치
  - [ ] 각 스킬 항목에 bold name, description, trigger 포함
  - [ ] `parseWorkflowMarkdown()` + `renderPrompt(strict: true)` 라운드트립 정상
  - [ ] `pnpm --filter @gh-symphony/cli test` 전체 통과
  - [ ] `pnpm typecheck` 통과

  **QA Scenarios** (MANDATORY):

  ```
  Scenario: Related Skills section generated with skills
    Tool: Bash
    Steps: pnpm --filter @gh-symphony/cli test -- --reporter=verbose packages/cli/src/workflow/generate-workflow-md.test.ts
    Expected: New test "includes Related Skills section when relatedSkills provided" passes
    Evidence: .sisyphus/evidence/task-2-related-skills-present.txt

  Scenario: Related Skills section absent when no skills
    Tool: Bash
    Steps: pnpm --filter @gh-symphony/cli test -- --reporter=verbose packages/cli/src/workflow/generate-workflow-md.test.ts
    Expected: New test "omits Related Skills section when relatedSkills is undefined" passes
    Evidence: .sisyphus/evidence/task-2-related-skills-absent.txt

  Scenario: Round-trip still works with Related Skills
    Tool: Bash
    Steps: pnpm --filter @gh-symphony/cli test -- --reporter=verbose packages/cli/src/workflow/generate-workflow-md.test.ts
    Expected: Existing round-trip test still passes, new round-trip test with relatedSkills passes
    Evidence: .sisyphus/evidence/task-2-roundtrip.txt
  ```

  **Commit**: YES | Message: `feat(cli): add Related Skills section to generated WORKFLOW.md` | Files: [packages/cli/src/workflow/generate-workflow-md.ts, packages/cli/src/workflow/generate-workflow-md.test.ts]

- [ ] 3. init.ts에서 스킬 메타데이터를 generateWorkflowMarkdown()에 전달

  **What to do**:
  1. init.ts 상단에 헬퍼 함수 추가:
     ```typescript
     function buildRelatedSkillsFromTemplates(
       templates: SkillTemplate[]
     ): Array<{ name: string; description: string; trigger: string }> {
       return templates
         .filter((t) => t.name !== "gh-symphony") // 메타 스킬 제외
         .map((t) => ({
           name: t.name,
           description: t.description,
           trigger: t.trigger,
         }));
     }
     ```
  2. 3개 direct call site에 relatedSkills 전달:
     - Line ~357 (`runNonInteractive`): `relatedSkills: buildRelatedSkillsFromTemplates(ALL_SKILL_TEMPLATES)`
     - Line ~473 (`runInteractiveFromTenant`): `relatedSkills: buildRelatedSkillsFromTemplates(ALL_SKILL_TEMPLATES)`
     - Line ~677 (`runInteractiveStandalone`): `relatedSkills: buildRelatedSkillsFromTemplates(ALL_SKILL_TEMPLATES)`
  3. `writeConfig()` (line ~835)의 `generateWorkflowMarkdown()` 호출에도 동일하게 전달:
     - `relatedSkills: buildRelatedSkillsFromTemplates(ALL_SKILL_TEMPLATES)`
  4. `--skip-skills` 플래그 시에도 relatedSkills는 전달 (WORKFLOW.md에는 항상 포함 — 스킬 파일 쓰기만 건너뜀)

  **Must NOT do**:
  - `tenant.ts` 수정
  - `WriteConfigInput` 타입 변경
  - 기존 init 플로우 로직 변경 (파라미터 추가만)

  **Recommended Agent Profile**:
  - Category: `quick` — 기존 함수 호출에 파라미터 추가만
  - Skills: [] — 특별한 스킬 불필요
  - Omitted: [`playwright`] — UI 작업 없음

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [F1-F4] | Blocked By: [1, 2]

  **References**:
  - init handler: `packages/cli/src/commands/init.ts:112-124` — handler 함수
  - Non-interactive call: `packages/cli/src/commands/init.ts:357-364` — `generateWorkflowMarkdown()` 호출
  - Interactive-from-tenant call: `packages/cli/src/commands/init.ts:473-479` — `generateWorkflowMarkdown()` 호출
  - Interactive-standalone call: `packages/cli/src/commands/init.ts:677-684` — `generateWorkflowMarkdown()` 호출
  - writeConfig call: `packages/cli/src/commands/init.ts:835-844` — `generateWorkflowMarkdown()` 호출 (tenant WORKFLOW.md 생성)
  - ALL_SKILL_TEMPLATES import: `packages/cli/src/commands/init.ts:46` — 이미 임포트됨
  - SkillTemplate type: `packages/cli/src/skills/types.ts:18-22` — description/trigger 필드 참조
  - Init test: `packages/cli/src/commands/init.test.ts` — 기존 init 테스트

  **Acceptance Criteria** (agent-executable only):
  - [ ] `pnpm --filter @gh-symphony/cli test` 전체 통과
  - [ ] `pnpm typecheck` 통과
  - [ ] `pnpm lint` 통과
  - [ ] `pnpm build` 성공
  - [ ] 4개 call site 모두 `relatedSkills` 파라미터 전달 확인 (grep으로 검증)

  **QA Scenarios** (MANDATORY):

  ```
  Scenario: All tests pass after wiring
    Tool: Bash
    Steps: pnpm test
    Expected: Exit code 0, all tests pass across all packages
    Evidence: .sisyphus/evidence/task-3-all-tests.txt

  Scenario: Full verification suite
    Tool: Bash
    Steps: pnpm lint && pnpm test && pnpm typecheck && pnpm build
    Expected: All 4 commands succeed with exit code 0
    Evidence: .sisyphus/evidence/task-3-full-verify.txt

  Scenario: relatedSkills parameter present at all call sites
    Tool: Bash
    Steps: grep -n "relatedSkills" packages/cli/src/commands/init.ts
    Expected: At least 4 matches (3 direct calls + 1 writeConfig call + helper function)
    Evidence: .sisyphus/evidence/task-3-callsite-grep.txt
  ```

  **Commit**: YES | Message: `feat(cli): wire skill metadata into WORKFLOW.md generation during init` | Files: [packages/cli/src/commands/init.ts]

## Final Verification Wave (4 parallel agents, ALL must APPROVE)

- [ ] F1. Plan Compliance Audit — oracle
  - 모든 Must Have 항목 충족 확인
  - 모든 Must NOT Have guardrail 준수 확인
  - WORKFLOW.md에 Related Skills 섹션 존재 확인

- [ ] F2. Code Quality Review — unspecified-high
  - 타입 안전성 확인 (pnpm typecheck)
  - 린트 통과 확인 (pnpm lint)
  - 코드 스타일 일관성 확인

- [ ] F3. Real Manual QA — unspecified-high
  - 테스트 전체 실행 (pnpm test)
  - 빌드 성공 (pnpm build)
  - 생성된 WORKFLOW.md 내용 검증

- [ ] F4. Scope Fidelity Check — deep
  - 수정 대상 외 파일 변경 없음 확인
  - tenant.ts, reference-workflow.ts, 스킬 생성기 파일 미수정 확인
  - core 패키지 변경 없음 확인

## Commit Strategy

```
feat(cli): add description and trigger fields to SkillTemplate type
feat(cli): add Related Skills section to generated WORKFLOW.md
feat(cli): wire skill metadata into WORKFLOW.md generation during init
```

## Success Criteria

- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 모두 통과
- relatedSkills 전달 시 WORKFLOW.md에 `## Related Skills` 섹션 포함
- 섹션에 5개 스킬 (gh-symphony 제외) 이름, 설명, 사용 시점 포함
- relatedSkills 미전달 시 하위 호환 유지 (섹션 미출력)
- 기존 테스트 100% 통과

# Standalone 프로젝트 모델 — Issue Breakdown Plan

> **Source spec:** `docs/designs/2026-08-11-standalone-project-model-design.md` (커밋 `d994c6e`)
> **Repository:** `hojinzs/github-symphony`
> **Status:** Active — gh-symphony 개밥먹기로 실행 (Project #14, 초기 상태 Backlog, Ready 승격은 사람)
> **구성:** 에픽 1 + 구현 이슈 9. 각 이슈 본문은 `gh issue create --body-file -`에 바로 사용 가능.

설계 문서가 단일 진실 소스다. 각 이슈에는 워커가 문서 전체를 읽지 않아도 되도록 해당 슬라이스를 임베드한다.

## Dependency graph

```
┌─ #1 D2 core: ProjectConfig 확장 ──────────── (기반 — 전부 이것에 의존)
│
├──┬─ #2 D3: 워크플로우 소스 해석 + 그림자 경고
│  └─ #3 D4a: bare 클론 캐시 모듈 (락·TTL fetch)     ← #2와 병렬 가능
│         │
│         └─ #4 D4b+D8: worktree populate + 브랜치 템플릿 + 정리 수명주기
│                │
│                └─ #6 D5: 스킬 레이어 병합 주입 + git exclude
│
├─ #5 D9: 프로젝트 .env 재배치 + $VAR 소스 확장      ← #2~4와 병렬 가능
├─ #7 D6: MCP 레이어링 (.mcp.json 사이드카)          ← #1 후 병렬 가능
│
└─ #8 CLI: project add / 프로젝트 폴더 기동 + 서로소 검증   ← #2 후
      │
      └─ #9 클로저: Docker E2E + docs + changeset + ADR    ← 전부 후
```

## Verification gates

모든 이슈의 PR은 다음을 통과해야 한다:

```bash
pnpm lint && pnpm test && pnpm typecheck && pnpm build
```

CLAUDE.md 규약: 작업 완료 후 반드시 TC를 작성하고 실행해 검증한다. 단위 테스트로 부족한 통합 동작은 Docker E2E(AGENT_TEST.md)로 검증한다 — E2E 통합 검증은 #9가 담당하되, 각 이슈도 자기 범위의 단위/통합 TC를 포함한다.

---

## Epic — Standalone 프로젝트 모델 구현

**Title:** `epic: standalone project model (repo-decoupled projects)`
**Labels:** `epic`
**초기 상태:** Backlog (트래킹 전용 — Ready로 승격하지 않는다)

```markdown
## 개요

오케스트레이션 정책(WORKFLOW.md·스킬·MCP·env)의 저장 위치를 소스 리포지토리에서 분리하는
standalone 프로젝트 모델 구현. 설계: `docs/designs/2026-08-11-standalone-project-model-design.md` (D1~D9).

한 문장: 프로젝트 폴더(WORKFLOW.md + .mcp.json + .env + .agent/skills)가 실행 단위가 되고,
리포는 Symphony가 도는지 모른다 (repo-unaware). 리포 1 : 프로젝트 N.

## 하위 이슈

- [ ] #1 feat(core): OrchestratorProjectConfig 확장
- [ ] #2 feat(orchestrator): 워크플로우 소스 해석
- [ ] #3 feat(orchestrator): bare 클론 캐시
- [ ] #4 feat(orchestrator): worktree populate + 브랜치 네임스페이스
- [ ] #5 feat(orchestrator): 프로젝트 .env 재배치
- [ ] #6 feat(worker): 스킬 레이어 주입
- [ ] #7 feat(core,runtime): MCP 레이어 합성
- [ ] #8 feat(cli): standalone 프로젝트 등록·기동
- [ ] #9 test(e2e): E2E + docs + changeset + ADR

(발행 후 실제 이슈 번호로 갱신)

## 순서

#1 → {#2, #3, #5, #7 병렬} → #4 → #6, #2 → #8 → #9

## 완료 기준

- Docker E2E: 프로젝트 폴더 생성 → 등록 → run-once → worktree populate → 스킬/MCP 주입 → 워커 실행까지 블랙박스 통과
- 기존 repo-embedded 모드 회귀 없음
- "1 project = 1 instance" 후속 ADR 병합
```

---

## Issue #1 — feat(core): extend OrchestratorProjectConfig for standalone projects

**Labels:** `core`, `enhancement`
**Depends on:** 없음 (기반)
**Effort:** S

```markdown
Part of epic #<EPIC>. 설계: docs/designs/2026-08-11-standalone-project-model-design.md — D2.

## 배경 (설계 슬라이스)

"프로젝트"를 리포와 독립된 일급 실행 단위로 만든다. 새 개념을 만들지 않고 기존
`OrchestratorProjectConfig`(packages/core/src/contracts/status-surface.ts)를 확장한다.
프로젝트 폴더가 진실 소스, 오케스트레이터의 config.json은 등록/파생 상태다.

## 작업 범위

- [ ] `OrchestratorProjectConfig`에 필드 추가:
  - `workflowSource: { type: "repo" } | { type: "external"; path: string }` (기본: 기존 동작 = repo)
  - `populateStrategy?: "clone" | "worktree-cache"` (기본: "clone" = 기존 동작)
  - `projectDir?: string` (standalone 프로젝트 폴더 경로)
- [ ] fs-store(`packages/orchestrator/src/fs-store.ts`) 영속화 라운드트립 + 하위 호환 (기존 config.json 필드 없음 = repo/clone 기본값)
- [ ] CLI `CliProjectConfig`(packages/cli/src/config.ts) 파생 타입 정합
- [ ] 검증: external인데 path 부재/비절대경로 → 명시 에러

## Acceptance Criteria

- 기존 config.json(신규 필드 없음)을 로드하면 동작 변화 없음 (하위 호환 TC)
- 신규 필드 저장→로드 라운드트립 TC
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #2 — feat(orchestrator): mode-declared workflow source resolution with shadow warning

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #1
**Effort:** M

```markdown
Part of epic #<EPIC>. 설계: D3 (+ D1).

## 배경 (설계 슬라이스)

워크플로우 소스는 우선순위 경쟁이 아니라 모드 선언이다: `workflowSource.type === "external"`이면
프로젝트 폴더의 WORKFLOW.md만 읽고 리포 내부는 조회하지 않는다. "repo"면 기존 동작(체크아웃 내 탐색).
외부 파일 로딩은 업스트림 스펙 §5.1 우선순위 1번("explicit runtime setting")이라 conforming.
보안 근거: hooks.\*는 호스트에서 셸을 실행하므로 리포 커밋 권한자가 운영자 머신 셸을 얻으면 안 된다.

## 작업 범위

- [ ] 워크플로우 해석 경로(orchestrator의 WorkflowResolution 로딩)에 `workflowSource` 분기 추가
- [ ] external 모드: `<projectDir>/WORKFLOW.md` 로드, 부재 시 `missing_workflow_file` 에러 (스펙 §5.1 로더 규약 유지)
- [ ] external 모드의 동적 리로드: watch 대상을 외부 파일로 (스펙 §6.2)
- [ ] **그림자 경고**: external 모드인데 리포 체크아웃에도 WORKFLOW.md가 존재하면 status surface에 경고 노출 (Observability)
- [ ] front matter `repository` 확장 키 파싱 (D1 — 스펙 §5.3 확장 규칙; 미지 키 무시 호환 유지)

## Acceptance Criteria

- external 모드에서 리포 내 WORKFLOW.md가 절대 읽히지 않음을 증명하는 TC
- 그림자 상황 경고 TC / repo 모드 회귀 없음 TC
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #3 — feat(orchestrator): global bare clone cache with locked TTL fetch

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #1
**Effort:** M

```markdown
Part of epic #<EPIC>. 설계: D4 + "클론 캐시 운영 상세" 섹션.

## 배경 (설계 슬라이스)

리포 클론을 전역 캐시 `~/.gh-symphony/repos/<owner>/<repo>.git`(bare)에 한 번만 둔다.
같은 리포를 공유하는 프로젝트들은 서로 다른 프로세스이므로(D7) 조율은 파일 락뿐이다.
기존 `packages/orchestrator/src/git.ts`의 mkdir 락 패턴·상수(재시도 100ms, stale 30분, 타임아웃 2분)를 재사용한다.

## 작업 범위

- [ ] bare 캐시 모듈: 최초 `clone --bare`, 락(`<repo>.lock` mkdir 방식) 아래 직렬화
- [ ] TTL fetch: 마지막 fetch 60초 이내면 스킵 (bare 내 타임스탬프 마커, 락 아래 판정). 필요한 ref 부재 시 TTL 무시하고 fetch
- [ ] fetch 후 `git gc --auto`
- [ ] 인증: 기존 credential 경로(gh auth / credential helper) 그대로, 토큰을 캐시·워크스페이스에 기록하지 않음
- [ ] 캐시 홈은 `DEFAULT_CONFIG_DIR`(`~/.gh-symphony`) 기준, `GH_SYMPHONY_CONFIG_DIR` 오버라이드 존중

## Acceptance Criteria

- 동시 fetch 직렬화 TC (두 호출이 락으로 순차 실행)
- TTL 스킵/ref 부재 시 강제 fetch TC
- stale 락 회수 TC (기존 git.ts 락 시맨틱과 동일)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #4 — feat(orchestrator): worktree populate from clone cache with project-scoped branches

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #3 (+#1)
**Effort:** L

```markdown
Part of epic #<EPIC>. 설계: D4·D8 + "클론 캐시 운영 상세" 섹션.

## 배경 (설계 슬라이스)

이슈 workspace populate를 풀클론(`syncRepositoryForRun`) 대신 bare 캐시에서 worktree로 딴다.
`populateStrategy === "worktree-cache"`일 때만 — "clone"(기존) 경로는 그대로 유지 (롤아웃 분리).
git은 같은 브랜치의 이중 체크아웃을 거부하므로 브랜치 유일성이 git 레벨에서 강제된다 →
브랜치 템플릿 `symphony/<project-slug>/<sanitized-issue-id>` 필수 (front matter 오버라이드 허용).

## 작업 범위

- [ ] populate: bare 확보(#3) → TTL fetch → `git worktree add -b <branch> <workspace-path> origin/<base>` (락 아래)
- [ ] 브랜치 템플릿 기본값 + front matter 오버라이드 키
- [ ] 실패 시맨틱 (스펙 §9.3): attempt 에러, 신규 워크스페이스는 부분 생성물 제거 가능, 재사용 워크스페이스는 파괴적 리셋 금지
- [ ] 정리: startup terminal cleanup(스펙 §8.6) 지점에 `before_remove` 훅 → `git worktree remove` → 락 아래 `git worktree prune` 연결
- [ ] 고아 GC: populate 시 락 아래 `git worktree prune` 1회
- [ ] 전략 스위치: `populateStrategy`에 따라 기존 clone 경로/신규 worktree 경로 선택

## Acceptance Criteria

- worktree populate 성공/재사용/실패 시맨틱 TC
- 같은 리포 두 프로젝트가 같은 이슈 번호로 populate해도 브랜치 충돌 없음 TC (슬러그 네임스페이스)
- terminal cleanup 시 worktree 제거·prune TC
- `populateStrategy: "clone"` 회귀 없음 TC
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #5 — feat(orchestrator): project .env relocation and $VAR resolution source

**Labels:** `orchestrator`, `enhancement`
**Depends on:** #1
**Effort:** S

```markdown
Part of epic #<EPIC>. 설계: D9.

## 배경 (설계 슬라이스)

프로젝트 env는 `<projectDir>/.env`(dotenv, 0600)로 선언한다. front matter `env` 키는 만들지 않는다.
`readProjectEnv`(packages/orchestrator/src/service.ts)가 이미 프로젝트 디렉토리 `.env`를 워커 env에
병합 중이므로, standalone 프로젝트에서는 읽기 위치를 프로젝트 폴더로 재지정하는 작업이다.
우선순위 현행 유지: 명시 env > 호스트 process env > 프로젝트 .env.

## 작업 범위

- [ ] standalone 프로젝트(`projectDir` 존재)의 `.env` 읽기 위치를 프로젝트 폴더로
- [ ] `$VAR` 해석 소스 확장: front matter(§6.1)와 MCP 합성의 `$VAR`가 "호스트 process env + 프로젝트 .env"에서 해석
- [ ] `.env` 파일 권한 검사: 0600 아니면 경고 (읽기는 거부하지 않음 — 운영 편의)
- [ ] 에이전트 자동 전달 금지 유지: `SAFE_RUNTIME_ENV_KEYS` allowlist(runtime-codex) 변경 없음

## Acceptance Criteria

- standalone/.env 로딩 및 우선순위 TC (스프레드 순서 그대로)
- `$VAR` 해석이 프로젝트 .env 값을 집는 TC + 호스트 env가 이기는 TC
- 에이전트 env에 프로젝트 .env 키가 새지 않는 TC
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #6 — feat(worker): layered skill injection into worktrees

**Labels:** `worker`, `enhancement`
**Depends on:** #4
**Effort:** M

```markdown
Part of epic #<EPIC>. 설계: D5.

## 배경 (설계 슬라이스)

스킬은 리포에 커밋하지 않고 워커 실행 환경에 주입한다:
전역(`~/.gh-symphony/skills`) → 프로젝트(`<projectDir>/.agent/skills`) 레이어를 병합(이름 충돌 시
프로젝트 승리)해 **매 attempt 전(before_run 지점)** worktree의 런타임 네이티브 경로
(`.claude/skills` / `.codex/skills`)에 **복사**한다. 링크 금지(격리·샌드박스·스냅샷 관측 사유).
git 은폐: worktree별 `.git/info/exclude`에 스킬 경로 등록 (repo-unaware 유지).

## 작업 범위

- [ ] 레이어 병합 복사 모듈 (전역→프로젝트, nearest wins, 매 attempt 전체 재복사)
- [ ] populate(#4) 시 `.git/info/exclude`에 스킬 경로 등록
- [ ] 생성형 스킬(packages/cli/src/skills/templates)의 렌더링 시점을 프로젝트 생성/수정 시점으로 이동 — 렌더링 결과가 프로젝트 스킬 레이어에 저장, 주입 로직은 "병합해서 복사"만
- [ ] codex 런타임 스킬 발견 경로 검증 (cwd 기준인지 — 설계 Open Question 3) 후 배치 확정

## Acceptance Criteria

- 병합 규칙 TC (충돌 시 프로젝트 승리, 전역 단독, 프로젝트 단독)
- 재시도 attempt에서 수정된 스킬이 반영되는 TC (재복사)
- 주입된 스킬이 `git status`에 나타나지 않는 TC (exclude)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #7 — feat(core,runtime): layered MCP composition with project .mcp.json sidecar

**Labels:** `core`, `runtime`, `enhancement`
**Depends on:** #1
**Effort:** M~L

```markdown
Part of epic #<EPIC>. 설계: D6.

## 배경 (설계 슬라이스)

MCP 서버 선언을 레이어화한다: Symphony 내장(예약 이름 `github_graphql`/`linear_graphql`, 항상 승리) >
프로젝트 `<projectDir>/.mcp.json` > 전역 `~/.gh-symphony/mcp.json` > 리포 `.mcp.json`
(standalone에서 리포 레이어는 기본 off, `trust_repo_config` 옵트인 — MCP 엔트리는 호스트 실행
명령이므로 D3와 같은 보안 논리). 선언 shape는 표준 `mcpServers`. 시크릿은 리터럴 금지, `$VAR`만.
합성은 기존 `mcp-compose.ts` 패턴: 매 attempt, worktree 밖 runtime 디렉토리, 0600.

## 작업 범위

- [ ] core에 런타임 중립 MCP 레이어 병합 로직 (예약 이름 보호 포함)
- [ ] claude 어댑터: `composeClaudeMcpConfig`(packages/runtime-claude/src/mcp-compose.ts)에 프로젝트/전역 레이어 주입, 리포 레이어 옵트인 게이트
- [ ] codex 어댑터: 병합 결과를 `RuntimeToolDefinition` 등록으로 번역 (packages/runtime-codex/src/runtime.ts)
- [ ] 리터럴 토큰 검증: `.mcp.json` env 값이 `$VAR` 형식이 아니면 로드 거부 + 명시 에러
- [ ] `$VAR` 해석 소스는 #5와 정합 (호스트 env + 프로젝트 .env)

## Acceptance Criteria

- 레이어 우선순위 TC (내장 예약 이름을 프로젝트가 그림자 못 침)
- 리포 레이어 기본 off / 옵트인 on TC
- 리터럴 토큰 거부 TC
- 합성 파일 0600·worktree 밖 위치 TC (기존 시맨틱 유지)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #8 — feat(cli): standalone project registration and startup

**Labels:** `cli`, `enhancement`
**Depends on:** #2
**Effort:** M

```markdown
Part of epic #<EPIC>. 설계: D2·D7(등록 검증 부분)·목표 디렉토리 구조.

## 배경 (설계 슬라이스)

standalone 프로젝트를 CLI로 등록·기동한다. 수퍼바이저 상세는 별도 스펙이지만, 프로젝트 폴더 기반
등록과 단일 프로젝트 기동은 CLI 몫이다. 등록 시 같은 리포+트래커를 공유하는 기존 프로젝트와의
트래커 매핑 서로소 검증(경고)을 수행한다 — 겹치면 두 오케스트레이터가 같은 이슈를 집는다.

## 작업 범위

- [ ] `gh-symphony project add <projectDir>`: WORKFLOW.md front matter 파싱 → `OrchestratorProjectConfig`(external source) 생성·등록 (`~/.gh-symphony/projects/<id>/project.json`)
- [ ] 등록 검증: front matter 파싱·dispatch preflight(스펙 §6.3) + 기존 등록 프로젝트와 트래커 매핑 겹침 검사 (겹침 = 경고 + 확인 요구)
- [ ] 기동: 기존 start 경로가 `workflowSource: external` 프로젝트를 프로젝트 폴더 기준으로 실행 (cwd 리포 전제 제거)
- [ ] `project list`/`status`에 standalone 프로젝트 표시 (그림자 경고 포함, #2 연동)

## Acceptance Criteria

- add→list→start→stop 라운드트립 TC
- 트래커 매핑 겹침 경고 TC
- repo-embedded 기존 플로우(`repo init`/`repo start`) 회귀 없음 TC
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

---

## Issue #9 — test(e2e): standalone project model end-to-end + docs + changeset + ADR

**Labels:** `test`, `documentation`
**Depends on:** #1~#8 전부
**Effort:** M

```markdown
Part of epic #<EPIC>. 설계: 전체 (클로저).

## 작업 범위

- [ ] Docker E2E (AGENT_TEST.md 규약): 프로젝트 폴더 생성(WORKFLOW.md/.mcp.json/.env/.agent/skills) →
      `project add` → `run-once` → bare 캐시 생성 → worktree populate(브랜치 네임스페이스 확인) →
      스킬/MCP 주입 확인(git status 청정 포함) → 워커 실행까지 블랙박스 검증
- [ ] 같은 리포 위 프로젝트 2개 병행 시나리오 (서로소 매핑, 브랜치 격리)
- [ ] `docs/configuration.md` 갱신: standalone 모드, 프로젝트 폴더 규약, populate 전략, 브랜치 템플릿, .env
- [ ] changeset 작성 (`@gh-symphony/*` minor)
- [ ] 후속 ADR: `2026-05-04_single-repo-orchestrator.md`("1 repo = 1 instance")를 "1 project = 1 instance"로 정밀화하는 결정 기록
- [ ] 설계 문서 Status: Draft → Shipped 갱신

## Acceptance Criteria

- E2E 블랙박스 통과 (신규 standalone + 기존 repo-embedded 양쪽)
- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` 통과
```

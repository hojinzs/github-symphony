# Spec: 에이전트 부트스트랩 플러그인과 PM 스튜어드

- **Date**: 2026-08-11
- **Status**: Draft
- **Symphony Layers**: Policy (WORKFLOW.md 생성), Configuration (프로젝트 폴더 산출물), Coordination (프로젝트 등록, PM 감독), Observability (보고, 상태 감시)
- **Related**:
  - `docs/designs/2026-08-11-standalone-project-model-design.md` — 본 스펙의 전제. D1~D9 결정을 기본 규약으로 삼는다.
  - 수퍼바이저 상세 설계 (별도 스펙, 미작성) — PM 스튜어드의 상태 조회 대상.

## Context / Problem

Symphony를 시작하는 경로가 현재는 "사람이 CLI를 익혀 리포에서 직접 세팅"뿐이다. 목표는 세 가지다:

1. **에이전트 주도 시작** — Claude/Codex 에이전트가 discovery부터 세팅·기동까지 스스로 수행
2. **플러그인 배포** — 이 능력을 리포지토리에 배포 가능한 플러그인(스킬 세트)으로 패키징, standalone/멀티 오케스트레이터 규약(D1~D9)이 기본값
3. **PM 스튜어드** — PM 에이전트가 Symphony로 처리되는 프로젝트들을 감독·보고하는 운영 루프

### 히스토리 조사 결과

**(a) 심포니 스킬 4종** — `~/.claude/skills/`에 로컬 전용으로 존재 (2026-05-27 작성, v0.1.0, git 미관리, 리포 미포함):

| 스킬                                | 역할                  | 핵심 패턴                                                                                                                                                                              |
| ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-symphony-bootstrap`         | 제로베이스 셋업       | read-only discovery → 제안 → **승인 스코프만 적용**(plan/apply-local/apply-remote/seed-backlog/activate 5단계 모드) → readback 검증                                                    |
| `github-symphony-workflow-author`   | 정책 파일 생성        | discovery·lifecycle 결정 → WORKFLOW.md + `.gh-symphony/*.yaml`. 기존 사람 정책은 덮어쓰지 않고 패치                                                                                    |
| `github-symphony-project-lifecycle` | 상태 모델 설계        | 7-상태 기본 lifecycle(Backlog/Ready/In progress/In review/Land/Done/Blocked), active/wait/terminal 매핑, "In review는 사람 대기, Land는 자율 랜딩 큐" 원칙, option id는 readback으로만 |
| `github-symphony-project-steward`   | PM 에이전트 설치·운영 | 권한 레벨 0~4(Observer→Autonomous PM), `pm.yaml` 정책 파일, 자기완결 cron 프롬프트, 결정 큐(decision queue), 전이 허용/금지 표                                                         |

넷은 related_skills로 연결된 한 세트이며, 안전 설계(승인 게이트, readback 검증, 권한 레벨)는 성숙하다. 단 **전부 repo-embedded 시절 규약**을 전제한다 — 아래 "갱신 포인트" 참조.

**(b) `~/Projects/maintenance` PM 루프** — 실운영 중인 PM 워크스페이스 (`/loop 30m` + LOOP.md). 실사고에서 증류된 운영 규칙을 보유:

- **입력 수집 단일화**: `scripts/collect-inbox.sh` 하나로 쿼터·락·보드·코멘트·리뷰를 일괄 수집. "규칙이 흩어져 있으면 반드시 하나를 빠뜨린다" (2026-08-11 Ready 8건/승인 2건/changes-requested 각각 다른 이유로 누락된 사고)
- **중복 루프 락**: `state/loop-lock.json` (2026-08-11 두 세션 18시간 중복 실행 사고)
- **추정 보고 금지**: 외부 상태는 보고 시점에 실측, 못 했으면 "미확인" (CMS 재배포 대기 다중 사이클 오보 사고)
- **사람 결정 즉시 기록**: `docs/decisions/`
- **게이트**: 할당 게이트(봇 계정 assignee만), 승인 게이트 2중(Land 상태 + 사람 approve, Backlog→Ready 사람 이동), 파괴 금지 + 착수 전 권한 1회 시험
- **역할 분리**: 판단·검증·보고는 PM(Claude), 구현은 위임(`codex exec --cd <worktree> --full-auto`)
- **구조**: git 관리 워크스페이스, `docs/projects/`(계약별)·`docs/repository/`(리포별 노트), `state/`(커밋 대상), 사이클당 Slack 스레드

특기: maintenance의 `.projects/<repo>/base`(fetch 전용 베이스 클론) + `issue-N` worktree 구조는 **standalone 설계 D4와 독립적으로 수렴한 동일 패턴**이다. D4의 운영 실증에 해당한다.

## Scope — 3층 구조

```
[3] PM 스튜어드     프로젝트들을 감독·보고 (maintenance 루프의 일반화)
[2] 스킬 규약 갱신   4종 스킬을 D1~D9 규약 기준으로 재작성
[1] 플러그인 패키징  스킬을 리포 배포 가능한 플러그인으로
```

문서 계층: standalone 프로젝트 모델(전제) → 수퍼바이저 스펙(별도) → **본 스펙**(그 위의 에이전트 경험 레이어).

## Proposed Decisions

### B1. 스킬 소스를 모노리포로 이관, 플러그인으로 패키징

- 4종 스킬의 source of truth를 `~/.claude/skills/`(로컬)에서 **이 모노리포로 이관**한다 (예: `plugins/gh-symphony/skills/`). 버전 관리·리뷰·테스트 대상이 된다.
- 배포 형태: Claude Code **플러그인**(marketplace 규격, skills 동봉). Codex 쪽은 CLI가 렌더링해 배포하는 기존 방식(`skill-writer.ts`의 런타임별 경로)을 재사용한다.
- **두 스킬 패밀리를 구분한다**: 본 플러그인의 스킬은 **운영자 스킬**(사람/PM 에이전트의 세션에서 셋업·운영에 사용)이고, `packages/cli/src/skills/templates/`의 commit/push/land 등은 **워커 주입 스킬**(D5로 워커 worktree에 주입)이다. 서로 다른 레이어이며 배포 경로도 다르다.

### B2. 부트스트랩 기본값 = standalone 모드

- bootstrap의 산출물은 리포 커밋이 아니라 **프로젝트 폴더 생성**이다: `WORKFLOW.md`(front matter 매니페스트) + `.mcp.json` + `.env` + `.agent/skills/`. 리포는 아무것도 모른다 (repo-unaware).
- repo-embedded는 명시 옵션으로 유지 (`--mode repo-embedded`).
- `activate` 단계는 "리포에서 CLI 실행"이 아니라 **프로젝트 등록**(수퍼바이저/CLI `project add`)으로 바뀐다.
- discovery 단계에 추가: 기존 프로젝트 폴더·bare 캐시(`~/.gh-symphony/repos/`)·데몬/수퍼바이저 상태 확인.

### B3. 설정 산출물을 D1 규약으로 정렬 — `.gh-symphony/*.yaml` 분할 폐기

스킬들이 발명한 `.gh-symphony/context.yaml`·`lifecycle.yaml`·`actions.yaml` 분할은 스펙 밖 자체 규약이며 D1(front matter = 매니페스트)과 충돌한다. 재배치:

| 기존 (스킬 v0.1.0)                                           | 새 위치                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `context.yaml` (repo/tracker/project id/readback)            | WORKFLOW.md front matter (`tracker`, `repository` 확장 키)                                   |
| `lifecycle.yaml` (states, active/wait/terminal, transitions) | front matter `tracker.active_states`/`terminal_states` + core `WorkflowLifecycleConfig` 매핑 |
| `actions.yaml` (pick/implement/open_pr/land/block 규칙)      | WORKFLOW.md 본문 (프롬프트 정책 — 원래 Policy 레이어 소속)                                   |
| `pm.yaml`                                                    | 스튜어드 워크스페이스로 이동 (B4)                                                            |

lifecycle 스킬의 상태 모델 자체(7-상태, In review=사람 대기, Land=랜딩 큐, readback 원칙)는 **그대로 유지** — 저장 위치만 바뀐다.

### B4. PM 스튜어드 = maintenance 패턴의 일반화, 실행은 Symphony에 위임

스튜어드는 **자체 git 관리 워크스페이스**를 갖는 PM 에이전트다 (maintenance 구조 계승: LOOP.md류 사이클 정의, MAPPING.md류 관리대상 인덱스, `state/`, `docs/decisions/`).

maintenance와의 결정적 차이: **구현 위임 대상이 codex exec가 아니라 Symphony다.** maintenance 루프는 PM과 실행 오케스트레이션을 한 세션이 겸했지만, Symphony 위에서는 실행이 오케스트레이터/워커의 몫이므로 스튜어드의 역할은 다음으로 좁아진다:

1. **인테이크** — 사람 요청 → 이슈 초안 → (승인 후) 트래커 등록
2. **트리아지/승격** — Backlog 정리, Ready 승격 추천 (승인 게이트 유지)
3. **리뷰 조정** — 리뷰 요청, CHANGES_REQUESTED 감지 → 상태 전환으로 워커 재작업 유도
4. **랜딩 중계** — approve된 PR의 Land 이동 추천 (사람 승인 게이트)
5. **감시·보고** — 수퍼바이저 상태 API + 트래커를 실측해 사이클 보고 (Slack 스레드)
6. **이상 감지** — stale/blocked/오케스트레이터 degraded 등을 결정 큐로 승격

스튜어드 러너는 **불가지론**으로 설계한다: `/loop` 세션이든 Hermes cron이든 동일한 계약(자기완결 프롬프트 + `pm.yaml` 정책 + `state/`)으로 동작. steward 스킬의 권한 레벨 0~4와 전이 허용/금지 표는 유지한다.

### B5. maintenance 증류 규칙을 스튜어드 계약으로 승격

실사고에서 나온 규칙들을 일반 규약으로 명문화한다:

- **입력 수집 단일화** — 사이클 시작은 단일 수집 스크립트/명령의 출력으로만 판단
- **중복 루프 락** — 스튜어드 워크스페이스 `state/`에 세션 락
- **추정 보고 금지** — 외부 상태는 보고 시점 실측, 실측 불가 시 "미확인" 명기
- **사람 결정 즉시 기록** — `docs/decisions/` 규약
- **게이트 3종** — 할당 게이트, 승인 게이트 2중(Ready 승격·Land 머지), 파괴 금지 + 착수 전 권한 시험

## 스킬별 갱신 포인트 (v0.1.0 → v0.2.0)

### 공통

- [ ] `.gh-symphony/context.yaml`/`lifecycle.yaml`/`actions.yaml` 참조 전부 제거 → B3 재배치
- [ ] 산출물 위치: 리포 내부 → 프로젝트 폴더 (standalone 기본, repo-embedded는 옵션)
- [ ] 트래커 기본: 스킬은 Linear 중심 가정이 남아 있으나 현 구현은 GitHub Projects V2가 주력 — 현 구현 기준으로 재정렬

### `github-symphony-bootstrap`

- [ ] Hard rule 4 "Prefer one GitHub Symphony instance per repository" → **"1 project = 1 instance, 리포 1 : 프로젝트 N 허용"** (D2·D7). 같은 리포에 두 번째 프로젝트를 얹는 시나리오를 지원 흐름으로 추가
- [ ] Phase 1 discovery에 추가: 기존 프로젝트 폴더 스캔, `~/.gh-symphony/repos/` bare 캐시 유무, 데몬/수퍼바이저 liveness, **트래커 매핑 서로소 검사**(D7 등록 검증과 동일 로직 — 기존 프로젝트와 겹치면 경고)
- [ ] Phase 6 apply-local: 산출 파일을 `WORKFLOW.md`+`.mcp.json`+`.env`+`.agent/skills/`로 교체, `.env`는 0600 + 리터럴 토큰 금지·`$VAR` 안내 (D6·D9)
- [ ] Phase 9 activate: `gh-symphony project add`(수퍼바이저 등록) + 데몬 기동 + status 서버 readback으로 재정의
- [ ] 그림자 경고: 리포에 이미 WORKFLOW.md가 있으면 standalone 모드에서 shadowing 사실을 plan에 명시 (D3)

### `github-symphony-workflow-author`

- [ ] 산출물: WORKFLOW.md 하나로 통합 (front matter = 舊 context+lifecycle, 본문 = 舊 actions 정책 프로즈)
- [ ] front matter에 `repository` 확장 키, `workspace.root` 포함 (D1·D4)
- [ ] 브랜치 네이밍 기본값 `feat/<issue-number>-...` → **`symphony/<project-slug>/<issue-id>`** (D8 — 공유 bare의 worktree 브랜치 유일성 제약이므로 스타일 선택이 아님을 명기)
- [ ] PR 정책 프로즈는 유지 (issue closing 섹션, validation 섹션, 리뷰 인라인 코멘트 별도 수집 규칙 등 — 검증된 내용)

### `github-symphony-project-lifecycle`

- [ ] 상태 모델·검증 규칙·readback 원칙 유지 (가장 갱신이 적은 스킬)
- [ ] 산출 대상만 변경: `lifecycle.yaml` → front matter + core `WorkflowLifecycleConfig` (planning→human-review→implementation→awaiting-merge→completed 실행 페이즈와의 매핑 명시)
- [ ] 검증 항목 추가: 같은 리포를 공유하는 다른 프로젝트와의 상태 매핑 충돌 검사

### `github-symphony-project-steward`

- [ ] `pm.yaml` 위치: `.gh-symphony/pm.yaml`(리포) → 스튜어드 워크스페이스 (B4). PM 상태도 `.gh-symphony/state/` → 워크스페이스 `state/`
- [ ] 감시 대상: 단일 리포 → **프로젝트 목록** (수퍼바이저 상태 API가 1차 소스, 트래커 실측이 2차)
- [ ] cron 프롬프트 템플릿: repo workdir 기준 → 스튜어드 워크스페이스 + 프로젝트 인덱스 기준
- [ ] B5 규칙 5종을 Hard Safety Rules에 편입 (입력 수집 단일화, 중복 락, 추정 보고 금지, 결정 기록, 게이트)
- [ ] 러너 불가지론 명시: Hermes cron 전용 문구 제거, `/loop`·cron 공통 계약으로 재기술

## 목표 구조 (플러그인·스튜어드)

```
github-symphony 모노리포
  plugins/gh-symphony/                 # B1: 플러그인 소스 (Claude Code plugin 규격)
    skills/
      github-symphony-bootstrap/
      github-symphony-workflow-author/
      github-symphony-project-lifecycle/
      github-symphony-project-steward/

<스튜어드 워크스페이스>/                 # B4: maintenance 일반화 (git 관리)
  LOOP.md                              # 사이클 정의 (러너 불가지론)
  pm.yaml                              # PM 정책 (권한 레벨, 허용 전이, cadence)
  projects-index.md                    # 감독 대상 프로젝트 인덱스 (舊 MAPPING.md)
  docs/decisions/                      # 사람 결정 기록
  state/                               # 루프 락, 기준선, 커서
```

## Open Questions

1. **플러그인 규격 상세** — Claude Code marketplace 메타데이터, 버전 정책, 설치 UX (`/plugin install`?). Codex 배포 메커니즘(스킬 렌더링 경로) 확정
2. **스튜어드 ↔ 수퍼바이저 API 의존** — 감시 1차 소스로 쓸 상태 집계 API shape는 수퍼바이저 스펙에서 정의. 그 전까지 스튜어드는 트래커 실측만으로 동작 가능해야 함 (단계적 의존)
3. **스튜어드 워크스페이스의 표준 위치** — 프로젝트 폴더들과 나란히 둘지(`projects/` 형제), 완전 독립일지
4. **bootstrap의 WORKFLOW.md 자동 생성 품질 게이트** — Control Plane CP2와 공유할 검증 체크리스트 (front matter 파싱, 상태 정합, dispatch preflight 통과)
5. **maintenance 루프의 이관 여부** — maintenance 자체를 Symphony 위로 옮기는 것은 별도 판단 (현재는 패턴 공급원으로만 취급)

## 로드맵 (제안)

1. **Phase 1 — 이관·갱신**: 스킬 4종을 모노리포로 이관하고 위 갱신 포인트를 반영해 v0.2.0으로 (standalone 모델 구현과 무관하게 문서 작업으로 선행 가능; 단 검증은 구현 후)
2. **Phase 2 — 플러그인 패키징**: Claude Code 플러그인 규격 + Codex 렌더링 배포
3. **Phase 3 — 스튜어드 일반화**: B4·B5 계약으로 steward 스킬 재작성, maintenance에서 파일럿 (수퍼바이저 스펙 진행과 병행, API 의존은 단계적)

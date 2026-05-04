# ADR: Single-Repository Orchestrator Model 로 전환

- **Date**: 2026-05-04
- **Status**: Proposed
- **Related Spec**: `docs/symphony-spec.md` §3.1, §5.1
- **Reference Implementation**: <https://github.com/openai/symphony> (elixir)
- **Related ADRs**:
  - `docs/adr/2026-03-16_issue-centric-state-model.md` (시너지 — workspace key 단순화)
  - `docs/adr/2026-04-29_linear-tracker-integration.md` (PR #255, 직교 진행)
- **Investigation Basis**: `docs/2026-05-04_single-repo-orchestrator-feasibility.md` — 가정 4건에 대한 codex 독립 리뷰 결과 포함

## Context

upstream `docs/symphony-spec.md` §3.1, §5.1 은 **단일 리포지토리 + repo-local `WORKFLOW.md`** 모델을 명시한다. OpenAI Elixir 레퍼런스도 `./bin/symphony ./WORKFLOW.md` 한 명령으로 시작하며 한 인스턴스가 한 리포를 watch 한다.

현재 github-symphony 구현은 GitHub Project V2 가 여러 linked repository 를 가질 수 있다는 점을 1급으로 받아들여 multi-tenant 형태로 발전했다 (`docs/spec-gap-analysis.md` D4):

- `OrchestratorProjectConfig.repositories: RepositoryRef[]` (배열)
- 디스크 레이아웃 `<runtimeRoot>/projects/<projectId>/issues/<workspaceKey>/repository/`
- 키 체계 `projectId × repositoryId × workspaceKey`
- control-plane (`packages/control-plane/`) 도 `projectId` 라우팅

이 multi-tenant 노선은 다음 마찰을 누적시켰다:

1. **PR #255 (Linear) 와의 양식 충돌** — Linear 이슈에는 repo 개념이 없어 `tracker.settings.repository = "owner/repo"` 단일 매핑이 필요. GitHub array vs Linear single 로 어댑터 양식이 갈라진다.
2. **upstream spec 부합 약화** — spec §5.1 "the workflow file is expected to be repository-owned" 인데, 현재는 `loadProjectWorkflow` 가 `tenant.repositories[0]` 또는 `issue.repository` 를 고르는 정책 의존 동작 (`packages/orchestrator/src/service.ts:1100-1140`).
3. **부트스트랩 복잡도** — 사용자가 GitHub Project ID, projectSlug, projectConfig 디렉터리를 거쳐야 시작. spec/레퍼런스의 `cd repo && symphony start` 단순함을 잃음.

조사 결과 (`docs/2026-05-04_single-repo-orchestrator-feasibility.md`, codex 4건 리뷰):

- issue/run/workflow 처리 경로는 사실상 단일 repo 가정 위에서 동작 중. array 의존은 정책 집계 로직 ~3곳 (`service.ts:825,2527,2546`) 에 국한 — 단일 repo 로 가면 `min(x) → x` 로 **단순화** 되는 방향.
- `OrchestratorProjectConfig.repositories` 가 cross-repo 라우팅에 본질적으로 쓰이는 곳은 없다. issue.repository / run.repository 는 이미 단일 `RepositoryRef`.
- ADR `2026-03-16` 의 `deriveWorkspaceKey(identifier)` 채택과 강한 시너지 — 단일-리포 전환이 issue-centric 키 단순화를 더 자연스럽게 만든다.

## Decision

orchestrator 를 **단일-리포 watch** 모델로 전환한다.

### 핵심 모델

```
$ git clone git@github.com:acme/platform.git
$ cd platform
$ gh-symphony repo init     # WORKFLOW.md 인식/생성, tracker auth 검증
$ gh-symphony repo start    # cwd 의 WORKFLOW.md 정책으로 폴링 시작
```

- `OrchestratorProjectConfig.repositories: RepositoryRef[]` → `repository: RepositoryRef` 단일 필드.
- WORKFLOW.md 1차 출처는 **cwd (또는 명시된 리포 디렉터리)**. `--workflow-file <path>` override 는 spec §5.1 그대로 유지.
- 디스크 레이아웃 `.runtime/orchestrator/<workspaceKey>/...` — `<projectId>` 단계 제거.
- CLI 명령 (`init`/`start`/`status`/`stop`) 는 cwd 기반. `--project-id` 옵션은 **제거** (breaking change — §Resolved Decisions S-Q1).
- tracker config 는 `tracker.settings.repository = "owner/repo"` 모양으로 GitHub/Linear 공통.
- 한 머신에서 여러 리포를 운영하려면 **리포당 한 인스턴스** (별도 포트, 별도 `.runtime/`) — unix-style multiplex.

### 1 repo = 1 instance = 1 control-plane

```bash
$ cd ~/work/repo-a && gh-symphony repo start --web 4680
$ cd ~/work/repo-b && gh-symphony repo start --web 4681
```

리포지토리 수만큼 control-plane 인스턴스가 뜬다. 통합 대시보드는 본 전환 범위 밖 — 필요해지면 reverse proxy 또는 외부 aggregator 를 별도 ADR 로 다룬다.

## Consequences

### Positive

- **upstream spec 부합 회복** — `docs/spec-gap-analysis.md` D4 (multi-tenant workspace path) 해소.
- **PR #255 와 어댑터 contract 통일** — GitHub/Linear 모두 `tracker.settings.repository` 단일 모양.
- **키 체계 압축** — `(projectId × repositoryId × workspaceKey) → workspaceKey`. ADR `2026-03-16` 의 `deriveWorkspaceKey(identifier)` 채택과 시너지.
- **control-plane 단순화** — `ControlPlaneServerOptions.projectId` 와 server-side store 의 `projectId` 의존 제거.
- **부트스트랩 단순화** — `git clone → cd → init → start` 4단계.
- **인스턴스 격리** — 한 리포의 워커 폭주/시크릿 누출이 다른 리포에 영향 없음. `.env` 가 리포 디렉터리 안에 위치.

### Negative

- **통합 대시보드 자연성 상실** — 한 페이지에서 N 리포 활동을 보려면 reverse proxy 또는 외부 aggregator 필요. 본 전환에서는 감수.
- **운영 다중화 부담** — 5개 리포 운영 시 5개 프로세스 관리 (systemd/도커/foreman 등 외부 supervisor 권장).
- **Premature collapse risk: medium** (codex). 미래에 진짜 cross-repo 의존성 분석 같은 다중-리포 fan-in 기능이 필요하면 재도입 비용 발생. 다만 대부분의 single-tenant 도구가 같은 트레이드오프를 받아들임.

### Effort

- **추정 60~80h (1.5~2주) / 1인** — codex 상향 추정 반영.
- 핵심 변경 700~1,100 LoC. `service.test.ts` 94 suites 중 ~64개 fixture 갱신이 가장 큰 비용.

## Implementation Plan

| Phase | 범위 | 비고 |
|---|---|---|
| **P1 — Contract** | `packages/core/src/contracts/status-surface.ts:15-21` `repositories[]→repository`. `state-store.ts:11-40` 의 `projectId` 옵션화. `workspace/identity.ts:12-14,43-60` 의 `projectId` 제거 + `deriveWorkspaceKey(identifier)` 통합 (ADR `2026-03-16` 채택). | 타입 시스템이 다음 phase 견인. |
| **P2 — Service core** | `packages/orchestrator/src/service.ts:825,868-946,2527-2638` 정책 집계 로직 단순화 (`min(repos.x) → repository.x`). `fs-store.ts:43-188,297-346` 디스크 레이아웃 변경. | `service.test.ts` fixture 갱신 동반. |
| **P3 — CLI / migration** | `packages/cli/src/commands/{init,start,project,repo}.ts` cwd 기반. 기존 `.runtime/projects/<projectId>/...` 자동 promote 스크립트 (단일 projectId 발견 시). | breaking change 최소화. |
| **P4 — Control plane** | `packages/control-plane/src/server.ts`, `packages/dashboard/src/store.ts:33-47` 의 `projectId` 라우팅 제거. SPA route 일부 단순화. | UI 회귀 테스트. |
| **P5 — Tests / e2e** | `service.test.ts` 64 suite fixture 일괄 갱신. `e2e/seed/config.json` 검증. | 명세 부합 확인. |

각 Phase 는 독립 PR. P1 통과 후 P2 부터 본격 변경.

## Migration

기존 사용자의 `.runtime/orchestrator/projects/<projectId>/...` 처리:

1. **단일 `<projectId>` 디렉터리만 발견** — `gh-symphony repo init` 시 자동으로 내용을 `.runtime/orchestrator/` 루트로 promote. run records 의 `projectId` 필드는 마이그레이션 시 제거 (orchestrator-side namespace 자체가 사라지므로).
2. **다중 `<projectId>` 디렉터리 발견** — `gh-symphony repo init` 이 명시적 에러로 중단하고 사용자에게 manual cleanup 안내를 출력 (§Resolved Decisions S-Q2). 어느 디렉터리를 살리고 어느 것을 archive 할지 사용자가 직접 결정 후 재실행. 자동 분기 logic 도입하지 않음.

## Alternatives Considered

### A. 현재 multi-tenant 모델 유지 + spec divergence 문서화 강화

장점: 변경 비용 0. 단점: PR #255 어댑터 양식 분기, spec divergence 누적, control-plane 의 projectId 의존 영구화. **거부** — 마찰이 시간이 갈수록 누적.

### B. multi-tenant 유지 + Linear 어댑터에서만 "1 project = 1 repo" enforce

장점: GitHub 측은 그대로. 단점: 어댑터별 양식이 갈라진 채 굳어짐 — 이후 트래커 추가 시 같은 분기 재발. **거부** — 본질적 정렬을 미루는 선택.

### C. 본 ADR — 단일-리포 전환

장점: spec 부합 회복, 어댑터 contract 통일, ADR `2026-03-16` 시너지, 부트스트랩 단순화. 단점: 60~80h 비용, 통합 대시보드 자연성 상실. **채택**.

## Resolved Decisions (at proposal)

본 ADR 채택 시 함께 확정한 사항. 셋 다 breaking change 를 감수한다 — 단일-리포 전환 자체가 schema 깨는 변경이므로 이 시점에 함께 정리하는 편이 일관됨.

1. **S-Q1 — `--project-id` CLI 옵션 처리** → **완전 제거**. internal-only 유예 없음. 기존 사용자 스크립트는 cwd 기반으로 갱신 필요.
2. **S-Q2 — 마이그레이션 스크립트의 다중 `<projectId>` 처리** → **에러 + manual cleanup 안내**. `gh-symphony repo init` 이 다중 `<projectId>` 발견 시 명시적 에러로 중단. 자동 분기 logic 도입하지 않음. 사용자가 어느 디렉터리를 살릴지 결정 후 재실행.
3. **S-Q3 — `/api/v1/state` 응답에서 orchestrator-side `projectId`/`slug` 처리** → **완전 제거 + 대체 식별자 추가**. 응답에 `repository: { owner, name }` 1급 식별자 추가. GitHub Project V2 node ID 등 tracker-side 식별자가 필요하면 `tracker.subjectId` 또는 `tracker.settings.projectId` 형태로 노출 (정확한 필드 모양은 P4 Phase 에서 결정). dashboard/client 는 P4 에서 함께 갱신.

> **명확화**: 본 결정사항의 "projectId" 는 모두 **orchestrator-side namespace** (예: `"team-eng-symphony"`) 만 가리킨다. **tracker-side `projectId`** (GitHub Project V2 node ID — WORKFLOW.md 의 `tracker.settings.projectId` 에 위치) 는 그대로 유지하며, 오히려 응답에 노출되어 운영자가 "이 인스턴스가 어느 GitHub Project 를 watch 하는지" 더 잘 알게 된다.

## References

- 조사 문서: `docs/2026-05-04_single-repo-orchestrator-feasibility.md` (codex 4건 리뷰 인용 포함)
- spec gap 분석: `docs/spec-gap-analysis.md` D4
- upstream spec: `docs/symphony-spec.md` §3.1, §5.1
- OpenAI Elixir 레퍼런스: <https://github.com/openai/symphony/blob/main/elixir/README.md>
- 관련 PR: #255 (Linear adapter ADR draft)

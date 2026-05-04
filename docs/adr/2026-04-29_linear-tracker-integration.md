# ADR: Linear Tracker Integration

- **Date**: 2026-04-29
- **Status**: Draft
- **Related Spec**: `docs/symphony-spec.md` (Tracker layer), `CLAUDE.md` (Six Symphony Layers)
- **Related ADRs**: `docs/adr/2026-05-04_single-repo-orchestrator.md` (단일-리포 전환 — Linear 어댑터의 단일 repo 매핑과 양식 통일)
- **Depends On**: 단일-리포 ADR Phase P1 (Contract) 가 먼저 머지되어 `OrchestratorProjectConfig.repositories[] → repository` 와 `tracker.settings.repository` override 모양이 정착된 상태를 전제한다. 본 ADR 의 모든 코드 참조는 _post-single-repo_ 형태 기준.
- **Layers Affected**: Integration (신규 어댑터), Configuration (스키마 확장), Coordination (와이어링·CLI), Policy (선택)

## Context

GitHub Symphony는 현재 GitHub Project V2 (`packages/tracker-github`)와 파일 기반 fixture (`packages/tracker-file`) 두 가지 tracker만 지원한다. `OrchestratorTrackerAdapter` 계약(`packages/core/src/contracts/tracker-adapter.ts`)은 이미 추상화되어 있으나, 실제 운영 환경에서 Linear를 사용하는 팀의 도입 요구가 있다.

본 문서는 Linear를 1급 tracker로 추가하기 위한 상세 요구사항을 정의한다. VCS는 GitHub을 그대로 유지하고 Linear는 issue tracking 책임만 담당하는 **하이브리드 모델**을 채택한다.

## Goals

1. GitHub Project V2 외에 Linear를 1급 tracker로 지원해 멀티-트래커 환경에서 동일한 orchestration 루프를 재사용한다.
2. VCS는 GitHub 그대로 유지 — Linear는 issue tracking 책임만 갖고, PR/브랜치/머지는 기존 GitHub 스택이 처리한다.
3. 단일-리포 ADR 이 정착시킨 `OrchestratorTrackerAdapter` 계약 (`repository: RepositoryRef` 단일 필드 + `tracker.settings.repository` 옵셔널 override) 을 그대로 따르며, `tracker-file` 수준의 격리를 유지한다.

## Non-Goals

- Linear webhook 기반 푸시 모델 (1차 범위는 폴링 유지)
- Linear OAuth 멀티테넌트 인증 (1차 범위는 personal API key)
- Linear Cycles/Estimates/Triage inbox 등 고급 기능 (필요 시 후속 ADR)
- GitLab/Jira 등 다른 트래커 (별도 작업)
- Linear ↔ GitHub 양방향 자동 동기화 데몬 (필요 시 별도 패키지)

## User Stories

| # | 시나리오 | 결과 |
|---|---|---|
| US-1 | 운영자가 Linear 팀 `ENG`의 워크플로 상태가 `In Progress`인 이슈에 대해 GitHub Symphony를 돌리고 싶다 | orchestrator가 폴링 → worker dispatch → Linear 상태 갱신 |
| US-2 | Worker가 작업을 마치면 GitHub PR을 생성하고, PR URL을 Linear 이슈 코멘트로 남긴다 | Linear 이슈에 PR 링크 자동 attach |
| US-3 | Linear 이슈가 `Cancelled`로 변경되면 진행 중인 worker run이 abort된다 | 다음 polling tick에서 lease 해제 |
| US-4 | 한 머신에서 GitHub 인스턴스 (`repo-A` 의 cwd) 와 Linear 인스턴스 (`repo-B` 의 cwd) 를 동시에 운영한다 (점진 마이그레이션) | 인스턴스별 `.runtime/` 격리 — tracker 다른 두 인스턴스가 별도 포트로 공존 (단일-리포 ADR 의 unix-style multiplex) |
| US-5 | 운영자가 CLI로 `gs workflow preview --linear ENG-123` 실행 | Linear 이슈 단건 미리보기 |

## Domain Mapping (Linear ↔ Symphony)

| Symphony 개념 | GitHub Project V2 | Linear |
|---|---|---|
| Project (tracker container) | ProjectV2 (`projectId`) | Team (`teamId`) 또는 Project (`projectId`) |
| Tracked item id | issue node id | issue id (UUID) |
| `identifier` | `owner/repo#N` | `ENG-123` (Linear issue identifier) |
| `number` | `N` (정수) | Linear 자체 숫자 (`issue.number`) |
| State | Project field "Status" 옵션 | Linear `WorkflowState` (per-team) |
| Priority | 커스텀 필드 매핑 | `issue.priority` (0–4 enum) |
| Labels | issue labels | Linear `IssueLabel[]` |
| BlockedBy | dependency relations (custom) | Linear `IssueRelation` (`type=blocks`) |
| URL | `https://github.com/.../issues/N` | `https://linear.app/<workspace>/issue/<identifier>` |
| Repository | issue가 속한 repo | **Linear 이슈에는 repo 개념이 없음** → workspace config에서 `repository` 명시 필요 |

### Linear에는 repo가 없다는 핵심 차이

GitHub 이슈는 `owner/repo#N`으로 본질적으로 repo에 묶이지만 Linear 이슈는 그렇지 않다. 단일-리포 ADR 이후 orchestrator 인스턴스는 cwd 의 한 repo 를 watch 하므로, Linear 어댑터는 **그 인스턴스의 repo 를 자동으로 알 수 있다** (cwd 의 git remote 추론, 또는 `tracker.settings.repository` override).

- **기본**: 인스턴스의 cwd repo 가 모든 Linear 이슈의 라우팅 대상.
- **명시적 override**: `tracker.settings.repository = "owner/repo"` — cwd 와 다른 repo 를 강제하고 싶을 때만 사용 (예: 모노레포 안의 sub-path 운영).
- **Linear 측 work scope 좁히기** (후속): `tracker.settings.includeLabel = "repo:platform"` 등으로 _이 인스턴스가 처리할_ Linear 이슈 부분집합을 좁히는 용도. multi-repo fan-out 이 아니라 single-repo 인스턴스 _안_에서의 필터링이라는 점에 주의.

> 단일-리포 ADR 이전 초안에 있던 "라벨 기반 multi-repo 라우팅 (Phase 3)" 은 단일-리포 모델과 충돌하므로 제거됨. multi-repo 가 정말 필요한 사용자는 unix-style multiplex (리포당 인스턴스) 를 사용한다.

## Package Layout

```
packages/
├── tracker-linear/                # 신규
│   ├── src/
│   │   ├── adapter.ts             # Linear GraphQL 클라이언트 + 정규화
│   │   ├── orchestrator-adapter.ts # OrchestratorTrackerAdapter 구현
│   │   ├── validation.ts          # team/state 매핑 검증
│   │   └── index.ts
│   └── package.json
└── extension-linear-workflow/     # 신규 (Phase 2)
    ├── src/
    │   ├── linear-approval-client.ts  # ApprovalWorkflowClient (Linear)
    │   └── index.ts
    └── package.json
```

## Configuration Schema

```jsonc
// .gh-symphony/config.json (cwd 기반, single-repo ADR 이후 형태)
{
  "tracker": {
    "adapter": "linear",
    "bindingId": "linear-eng-team",
    "apiUrl": "https://api.linear.app/graphql",
    "settings": {
      "teamId": "TEAM_UUID_OR_KEY",
      "projectId": "LINEAR_PROJECT_UUID",     // Linear 측 ID (선택, 비우면 team 전체)
      "repository": "hojinzs/github-symphony", // 선택 — 미지정 시 cwd 의 git remote 에서 추론
      "includeLabel": "repo:platform",         // 선택 — Linear 측 work scope 필터
      "assignedOnly": "false",
      "priorityMapping": "linear-default",
      "timeoutMs": 30000
    },
    "lifecycle": {
      "active":    ["In Progress", "In Review"],
      "planning":  ["Backlog", "Todo"],
      "completed": ["Done"],
      "cancelled": ["Cancelled", "Duplicate"]
    }
  }
}
```

> 최상위 `projectId` 가 없는 점에 주목 — 단일-리포 ADR 이 orchestrator-side `projectId` 를 제거. tracker-side ID 는 `tracker.settings` 안에만 위치한다.

**환경 변수**:

- `LINEAR_API_KEY` (required) — Linear personal API key
- `LINEAR_GRAPHQL_URL` (optional override)

## OrchestratorTrackerAdapter Implementation

5개 메서드 모두 구현. GitHub과의 차이점만 기술한다.

### `listIssues(project, deps)`

- Linear GraphQL `issues(filter: { team: { id: $teamId }, state: { type: { in: [...] } } })`로 페이지네이션 (50건/page, cursor 기반)
- `tracker.settings.assignedOnly === "true"`면 `viewer` 쿼리로 user id 조회 후 `assignee: { id: { eq } }` 필터 추가
- `tracker.settings.includeLabel` 이 있으면 `labels: { name: { in: [...] } }` 필터 추가 (단일-리포 인스턴스의 work scope 좁히기)
- `repository` 는 cwd 의 git remote 추론 또는 `tracker.settings.repository` override 로 주입 (Linear 응답에는 없음)
- 정규화 함수가 Linear 응답을 `TrackedIssue`로 변환

### `listIssuesByStates(project, states)`

- GitHub과 달리 **Linear는 server-side state filter가 가능** → GraphQL `state: { name: { in: $states } }`로 직접 필터링 (per-tick cache 불필요)
- 결과적으로 ADR 2026-03-19의 `projectItemsCache` 의존성에서 자유로움 (deps에 cache가 와도 무시)

### `fetchIssueStatesByIds(project, ids)`

- `issues(filter: { id: { in: $ids } })`로 bulk 조회

### `buildWorkerEnvironment(project, issue)`

주입 env:

```
LINEAR_TEAM_ID=...
LINEAR_ISSUE_ID=...
LINEAR_ISSUE_IDENTIFIER=ENG-123
LINEAR_API_KEY=...
SYMPHONY_TRACKER_KIND=linear
```

### `reviveIssue(project, run)`

- `run.issueId`(Linear UUID), `run.issueIdentifier`(`ENG-123`), `run.issueState`로 최소 `TrackedIssue` 재구성
- `repository`는 cwd 또는 `tracker.settings.repository` override 에서 다시 주입 (run record 의 `repository` 필드도 단일-리포 ADR 이후 단일 `RepositoryRef`)

## Core Changes (최소화)

### `TrackerAdapterKind`

```ts
export type TrackerAdapterKind = "github-project" | "linear" | "file" | (string & {});
```

(이미 `(string & {})` 확장 가능 — 타입 명시만 추가)

### `TrackedIssue.number` 완화

Linear도 `issue.number`(팀 내 일련번호)를 가지므로 유지. 단, `identifier`가 `ENG-123` 포맷일 수 있음을 문서화한다.

### `OrchestratorTrackerConfig`

단일-리포 ADR 이후의 `OrchestratorTrackerConfig` (`adapter`, `bindingId`, `apiUrl`, `settings: Record<string, unknown>`) 그대로 사용. 신규 필드 없음 — Linear-specific 옵션은 모두 `settings` 안.

## Approval Workflow Integration (`extension-linear-workflow`)

`ApprovalWorkflowClient` 인터페이스를 Linear backend로 구현:

| 메서드 | Linear 매핑 |
|---|---|
| `findIssueCommentByMarker(issueId, marker)` | `issue.comments` 페이지네이션 → body에 marker 포함 검색 |
| `createIssueComment(issueId, body)` | `commentCreate` mutation |
| `updateIssueComment(commentId, body)` | `commentUpdate` mutation |
| `updateProjectItemState({…, state})` | `issueUpdate(input: { stateId })` — `state` 이름→`stateId` 해결 캐시 필요 |
| `findPullRequestByBranch(...)` | **GitHub backend로 위임** (Linear는 PR을 소유하지 않음) |
| `createPullRequest(...)` | **GitHub backend로 위임** + 생성 후 Linear 이슈에 PR URL 코멘트 |
| `updatePullRequest(...)` | **GitHub backend로 위임** |

### Hybrid Approval Client

- `LinearApprovalWorkflowClient`는 내부적으로 `GitHubApprovalWorkflowClient`를 composition으로 보유
- 이슈 관련 메서드 → Linear API
- PR 관련 메서드 → GitHub API에 그대로 위임
- 추가 책임: PR 생성 직후 Linear 이슈에 `Linked PR: <url>` 코멘트 (idempotent marker 사용)

## CLI Changes

- `packages/cli/src/commands/workflow.ts`의 `fetchGithubProjectIssueByRepositoryAndNumber` 직접 import 제거
- `resolveTrackerAdapter()`를 통해 어댑터 위임으로 변경
- `gh-symphony workflow preview ENG-123` 형식 식별자 인식 (정규식 `^[A-Z]+-\d+$` → linear, `owner/repo#N` → github)
- 단일-리포 ADR 이후의 `gh-symphony repo init` cwd 기반 흐름과 호환 — `repo init` 이 tracker `adapter: "linear"` 를 만나면 `LINEAR_API_KEY` 와 `teamId` 검증 단계를 추가

## Wiring

`packages/orchestrator/src/tracker-adapters.ts`:

```ts
const localAdapters = new Map<string, OrchestratorTrackerAdapter>([
  ["file", fileTrackerAdapter],
  ["linear", linearTrackerAdapter],
]);
```

## Observability

- 이벤트 타입은 변경 없이 재사용 (`tracker.list`, `tracker.fetchByIds`, `worker.dispatched`)
- 추가 메타데이터: `tracker.adapter = "linear"`, `tracker.linear.teamId`
- Rate limit: Linear는 응답 헤더 `X-RateLimit-Requests-Remaining`/`X-RateLimit-Requests-Reset` → 기존 `rateLimits` 필드에 정규화 저장

## Test Strategy

| 레벨 | 범위 |
|---|---|
| Unit | `tracker-linear` 정규화·필터링·priority 매핑 (mocked fetch) |
| Unit | `LinearApprovalWorkflowClient` 위임 동작 (PR 호출이 GitHub backend로 가는지) |
| Conformance | `core-conformance.test.ts` 패턴 따라 5개 메서드 계약 검증 |
| Integration | `tracker-adapters.ts` 가 `"linear"` 키를 올바르게 해석 |
| E2E (Docker) | `AGENT_TEST.md` 가이드에 따라 Linear sandbox team으로 1 issue 라이프사이클 (planning → completed) |

## Rollout

0. **Phase 0 (선행 의존)**: 단일-리포 ADR P1 (Contract) 머지. `OrchestratorProjectConfig.repository` 단일 필드, `tracker.settings.repository` override 모양 정착.
1. **Phase 1 (MVP, ~50h)**: tracker-linear 어댑터만, approval workflow는 mock — 운영자가 read-only 폴링/상태 동기화 검증. 단일-리포 ADR P1 의 단일 `repository` scaffolding 활용으로 ~5~10h 절감.
2. **Phase 2 (~60h)**: extension-linear-workflow 추가 — 풀 라이프사이클 (PR 생성 + Linear 코멘트)
3. **Phase 3 (후속)**: webhook 지원 + Linear 측 work scope 좁히기 (`includeLabel` 등 라벨 필터). 단일-리포 모델 하에서 multi-repo fan-out 은 본 ADR 의 범위 밖 — 필요 시 별도 ADR.

## Cost Estimate

| 작업 | 시간 |
|---|---|
| `packages/tracker-linear` (Linear GraphQL 클라이언트 + 5 어댑터 메서드, ~1,200 LOC) | 40~60h |
| Validation 모듈 (필드 매핑·중복 검출 — Linear 의미가 다름) | 8~12h |
| `tracker-adapters.ts` 등록·와이어링 | 2~4h |
| CLI `workflow` preview 명령 | 8~12h |
| `extension-linear-workflow` (`ApprovalWorkflowClient` 구현) | 20~30h |
| 단위/통합/E2E 테스트 | 16~20h |
| 문서화 | 4~6h |
| **합계** | **93~134h ≒ 2.3~3.4주 (1인 기준)** |

> 단일-리포 ADR P1 머지 후의 추정. P1 이 `repository: RepositoryRef` 단일 모양 + `tracker.settings.repository` override 흐름을 이미 깔아주므로, "Validation 모듈" 과 "와이어링" 항목에서 ~5~10h 절감.

## Open Questions

1. **인증 모델**: 1차는 personal API key 고정인가? 향후 OAuth 도입 시 worker env 주입 방식은?
2. **State 이름 vs ID**: Linear state는 team별 UUID — config에 이름으로 적되 런타임에 ID로 해석하는 캐시 위치 (orchestrator? adapter?)
3. **라벨 동기화**: GitHub PR 라벨과 Linear 라벨을 어느 방향으로 동기화할지? (1차 범위 제외 권장)
4. **이슈 식별자 충돌**: 동일 워크스페이스에 GitHub `#123`과 Linear `ENG-123`이 공존할 때 `runId` 생성 규칙
5. **PR ↔ Linear 링크 마커**: HTML 코멘트(`<!-- symphony:pr-link -->`)를 Linear comment body에 사용할지 마커 컨벤션
6. **테스트 자격증명**: CI에서 Linear sandbox 팀을 어떻게 격리·재사용할지

## Decision Points (합의 필요)

1. ~~**단일 repo 매핑으로 시작 vs 처음부터 라벨 라우팅**~~ — 단일-리포 ADR (`docs/adr/2026-05-04_single-repo-orchestrator.md`) 채택으로 자동 해소. orchestrator 인스턴스 = 단일 repo 가 mandated.
2. **Hybrid composition 모델** — Linear extension이 GitHub extension을 내부적으로 호출하는 구조에 대한 합의
3. **Phase 1 MVP 우선 머지 vs Phase 2까지 일괄 진행** — 본 문서는 Phase 1 우선을 권장

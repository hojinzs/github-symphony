# Spec: GitHub Project V2 디스패치를 데몬 자기 리포로 스코프

- **Date**: 2026-07-06
- **Status**: Shipped — `fix(tracker-github): scope Project V2 dispatch to daemon repo` (PR #435, `4499b07`)
- **Refs**: #433
- **Symphony Layers**: Integration (`tracker-github`), Coordination (dispatch selection), Observability (filter event)
- **Related ADRs**:
  - `docs/adr/2026-05-04_single-repo-orchestrator.md` — 이 스펙의 근본 배경. `repositories[]` → `repository` collapse와 "1 repo = 1 instance" 채택.
  - `docs/adr/2026-03-19_github-project-v2-state-filtering-cache.md` — Project V2 in-memory 필터링 컨텍스트.

## Context / Problem

`tracker.settings.repository`(또는 이에 준하는 repo 식별자)는 데몬별로 존재하지만 **디스패치 필터로 배선된 적이 없다.** GitHub Project V2 하나에 여러 linked repository가 담길 수 있는데, 셀렉션 루프의 유일한 in-memory 필터는 assignee(`assignedOnly`)뿐이다 (`packages/tracker-github/src/adapter.ts` 셀렉션 루프, `isIssueAssignedToLogin`).

결과: 하나의 Project(예: Project #14, `PVT_kwHOAPiKdM4BYPVD`)에 per-repo 데몬을 둘 이상 붙이면, 각 데몬이 프로젝트 전체 repo의 `--assigned-only` 아이템을 모두 집어간다 → 같은 이슈에 워커 2개가 붙어 squash-merge/branch push 레이스, workpad 중복.

### 히스토리 규명 (왜 필터가 "없었나")

git 아카이브 조사 결과 (본 세션 investigation):

- 셀렉션 루프에는 **최초 구현(bc1e7ca)부터 지금까지 `content.repository` 비교 필터가 존재한 적이 없다.** pickaxe `content.repository` → 추가 2건, 삭제 0건. 유일한 셀렉션 필터인 assigned-only는 `a4aa8ac`(2026-03-14)에서 추가됐고 지금도 그대로.
- 과거에 존재했다 제거된 repo-스코프 메커니즘은 두 개지만 **둘 다 디스패치 필터가 아니었다**:
  1. `OrchestratorProjectConfig.repositories: RepositoryRef[]` — 워크스페이스 레이아웃/cleanup/워크플로 해석/정책 집계용. single-repo ADR(2026-05-04)로 `repository` 단일 필드 collapse (PR #303 / #292).
  2. `allowed_repositories` WORKFLOW.md front matter → `allowedRepositories` — 워커 측 **클론 안전 allowlist**("Repository is not in the workspace allowlist" 가드). `1f8c8d6`(2026-03-13) 스펙 정렬로 제거.
- 따라서 이 작업은 "복원"이 아니라 **신규 추가**다. single-repo collapse가 "한 Project·다중 per-repo 데몬" 운영 형태를 유도했는데, 셀렉션이 repo로 스코프되지 않아 처음으로 필요해진 필터를 넣는 것. single-repo ADR이 남긴 "Premature collapse risk: medium" 공백을 메운다.

## Decision

GitHub Project V2 셀렉션을 **데몬 자기 리포로 자동 스코프하고, 명시적 오버라이드를 제공**한다.

핵심 관찰: 데몬은 **이미 자기 repo를 안다.** CLI가 cwd의 git `origin`에서 `RepositoryRef`(owner/name)를 해석해 (`packages/cli/src/repo-runtime.ts:248` `resolveRepository`, `git config --get remote.origin.url`) `OrchestratorProjectConfig.repository`(`packages/core/src/contracts/status-surface.ts:31`)에 넣는다. 이 값이 자동 스코프의 기본 소스다.

### 필터 해석 규칙

`tracker.settings.repository`(`readOptionalStringTrackerSetting(project.tracker, "repository")`) 값에 따라:

| 값                 | 해석 결과 (`repositoryFilter`)                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 미설정 / 빈 문자열 | **`{ owner: project.repository.owner, name: project.repository.name }`** — cwd origin으로 자동 스코프 (기본 동작) |
| `"owner/name"`     | `{ owner, name }` — 오버라이드 (cwd origin과 다른 repo를 노릴 때)                                                 |
| `"*"`              | `null` — 전체 디스패치 (opt-out 탈출구)                                                                           |

- sentinel은 `"*"` 하나만. `"all"` 등 별칭은 만들지 않는다 (YAGNI).
- `"owner/name"` 파싱은 `adapter.ts` ~L1304의 식별자 구성(`${owner.login}/${name}`)과 동일 규칙. 슬래시 1개, 양쪽 non-empty가 아니면 명시적 파싱 에러.

## Design

### 컴포넌트 1 — resolved config 타입 (`packages/tracker-github/src/adapter.ts:15`)

`GitHubTrackerConfig`에 필드 추가:

```ts
export type GitHubTrackerConfig = {
  // ...기존 필드...
  repositoryFilter?: { owner: string; name: string } | null;
};
```

### 컴포넌트 2 — 해석 (`resolveGitHubTrackerConfig`, `packages/tracker-github/src/orchestrator-adapter.ts:139`)

`project: OrchestratorProjectConfig`를 이미 받으므로 `project.repository`에 접근 가능. 반환 객체에 `repositoryFilter`를 위 표대로 계산해 추가:

```ts
const repositoryOverride = readOptionalStringTrackerSetting(
  project.tracker,
  "repository"
);
const repositoryFilter = resolveRepositoryFilter(
  repositoryOverride,
  project.repository
);
```

- `resolveRepositoryFilter(override, ownRepo)`: `"*"`→`null`; `"owner/name"`→파싱; 미설정→`{ owner: ownRepo.owner, name: ownRepo.name }`.
- `"*"`로 해석돼 `null`이 되면, 프로세스당 1회 정보성 경고 로그: repository 스코프 비활성 → 같은 Project를 여러 데몬이 watch하면 이중 디스패치 가능. (기존 `warnedLegacyAssignedOnlyProjectIds` 패턴처럼 dedupe.)

### 컴포넌트 3 — 셀렉션 루프 (`packages/tracker-github/src/adapter.ts`, assignee skip 직후 ~L513)

```ts
if (config.repositoryFilter) {
  const wanted = `${config.repositoryFilter.owner}/${config.repositoryFilter.name}`;
  const itemRepo = item.content?.repository
    ? `${item.content.repository.owner.login}/${item.content.repository.name}`
    : null;
  if (itemRepo !== wanted) {
    excludedByRepository += 1;
    return [];
  }
}
```

- draft / `content.repository` 부재 아이템: 필터 활성 시 매칭 불가로 **제외**.
- GraphQL item 쿼리는 **이미 `repository { name url owner { login } }`를 select** 중 → 쿼리 변경 불필요.

### 컴포넌트 4 — Observability (`packages/tracker-github/src/adapter.ts`)

`emitAssignedOnlyFilterEvent` 패턴을 미러한 `emitRepositoryFilterEvent`로 repo 제외 카운트 방출 (event: `tracker-repository-filtered`, payload에 `projectId`, `repository`(wanted), `excludedCount`).

## Backward Compatibility / Change Grade ⚠️

**기본 동작이 바뀐다**: 기존에는 Project-bound 데몬이 프로젝트 전 repo의 assigned 아이템을 디스패치했으나, 이제 자기 repo만 디스패치한다. 이것이 의도된 수정(#433)이지만 behavior change다.

- 탈출구: `tracker.settings.repository: "*"` → 전 repo 디스패치 복원.
- 자동 스코프 덕분에 원래 이슈가 우려한 "미설정 데몬 이중 디스패치" 시나리오는 **기본값에서 소멸**한다 (두 per-repo 데몬이 자동으로 disjoint). 잔여 리스크는 `"*"`로 스코프를 끈 데몬뿐 → 컴포넌트 2의 경고 로그로 커버.
- Changeset: **minor** (feat, 동작 변경). 원래 이슈 초안의 patch가 아님. 릴리스 노트에 behavior change와 `"*"` 탈출구를 명시.

## Testing

`packages/tracker-github/src/*.test.ts` 단위 테스트 (동일 mocked Project V2 payload 재사용):

1. **자동 스코프 disjoint**: 같은 `projectId`, 다른 `project.repository`인 두 config → 각자 자기 repo 아이템만, 교집합 없음.
2. **회귀 가드 (변경됨)**: `repository` 미설정 config → 전체가 아니라 `project.repository`로 스코프됨을 단언.
3. **opt-out**: `tracker.settings.repository: "*"` → 전 repo 아이템 모두 디스패치.
4. **오버라이드**: `"owner/name"`이 cwd origin과 다르면 오버라이드 repo로 필터(cwd origin 아님).
5. **assignee 교차 제외**: `content.repository`가 필터와 다른 아이템은 current user에게 assigned여도 제외.
6. **draft 제외**: `content.repository` 없는 아이템은 필터 활성 시 제외.
7. **파싱 에러**: 슬래시 없는/빈 쪽 있는 override 값은 명시적 에러.

## Verification (repo review rules)

- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` green.
- `gh-symphony doctor --smoke` 통과.
- `gh-symphony repo start --once` dry-run on a project → 자기 repo 아이템만 선택됨을 확인, dispatch summary를 workpad에 첨부.

## Out of Scope

- 비-GitHub 트래커(`tracker-file`, `tracker-linear`) 무변경.
- 데몬 프로세스 모델 무변경 — in-memory 디스패치 필터 + config 배선만.
- assignee(`assignedOnly`) 필터 유지, 무변경.
- GraphQL item 쿼리 무변경 (이미 repository owner/name select).
- 크로스-프로세스 이중-디스패치 감지 미구현 (문서 + 경고 로그로 갈음).

## Alternatives Considered

- **A. 명시적 opt-in만 (이슈 원안)**: 새 `tracker.settings.repository`, 미설정=전체 디스패치(불변). 완전 백워드 호환이나 사용자가 수동 설정해야 하고 미설정자는 #433 지속. `project.repository`와 중복. **거부** — 자동 스코프가 데이터가 이미 있는데도 사용자에게 짐을 지움.
- **B. 자동 스코프 강제 (오버라이드 없음)**: 항상 `project.repository`로 필터. 가장 단순하고 ADR에 충실하나 한 프로젝트의 여러 repo를 한 데몬으로 디스패치하던 setup이 탈출구 없이 깨짐. **거부** — 탈출구 부재.
- **C. 자동 스코프 + 명시적 오버라이드 (채택)**: 기본 자동 스코프로 #433을 무설정으로 해소, `"owner/name"` 오버라이드와 `"*"` opt-out 제공. single-repo ADR 철학과 일치하며 탈출구 보존.

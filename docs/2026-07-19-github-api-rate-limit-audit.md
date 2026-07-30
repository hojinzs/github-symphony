# GitHub API rate limit 소진 문제 감사 리포트

- **작성일**: 2026-07-19
- **범위**: `packages/tracker-github`, `packages/orchestrator`, `packages/tool-github-graphql` — GitHub API를 소비하는 전 경로
- **계기**: GitHub Project를 트래커로 사용하는 오케스트레이터에서, 여러 리포지토리를 오케스트레이션할 때 GraphQL 한도가 빠르게 소진됨
- **방법**: 디스패치 루프 정적 추적 → 호출 지점 전수 조사 → 중복/N+1 식별 → 제거 가능성에 대한 적대적 검증(정말 중복인지 반증 시도)
- **상태**: 검수 대기 (구현 미착수)

> ✅ **2026-07-19 갱신: 비용은 실측값으로 대체되었다.** 초판의 추정치(페이지당 ~245pt)는 문서상 노드 곱셈 공식에 근거한 것으로, **실측 결과 11pt로 약 22배 과대평가였다.** 실 GitHub API가 반환한 `rateLimit { cost }` 기준으로 전면 수정했다.
>
> 측정 환경: 현행 `PROJECT_ITEMS_QUERY`와 동일한 중첩 구조를 `gh api graphql`로 직접 호출. 검증용 보드(61 아이템)와 **실제 운영 보드(`PVT_kwDOBB0_W84BRapW`, 90 아이템)** 양쪽에서 동일 결과 확인.
>
> **초판 대비 결론이 바뀐 항목: P1(비용 귀속), P10(API 제약 → 해소됨), P9(아카이브 동작), R1.5(격하), 부록 A(전면 교체).**

---

## 요약

핵심 결론: **토큰/키를 분리해도 문제는 해결되지 않는다.** GitHub의 primary rate limit은 토큰 단위가 아니라 인증 주체(계정) 단위이므로, 같은 계정으로 PAT을 N개 발급해도 5,000 point/hr 버킷을 공유한다.

실제 원인은 **① 쿼리 한 건의 point 비용**(P1) × **② 상태 무관 보드 전량 조회**(P10) 두 축이 곱해진 것이다. 초판이 세 번째 축으로 지목한 **③ 배치 구조 중복(P2)은 실측 결과 현재 배포에 해당하지 않는다.**

**운영 환경 실측 결론 — 데몬 1대만으로 한도를 초과한다.**

실제 배포(`/Users/steve/Projects/ioa-tracker`, 단일 데몬, 단일 리포, 보드 90 아이템, 30초 폴링)를 측정한 결과:

```
4 페이지 × cost 11 = 44 pt/cycle × 120 cycle/hr = 5,280 pt/hr
                                    한도 5,000 대비 → 106% (초과)
```

**"여러 리포지토리를 오케스트레이션할 때"가 조건이 아니었다. 리포 하나, 데몬 하나로 이미 초과한다.** 여러 리포는 증상을 앞당겼을 뿐 원인이 아니다. 따라서 초판이 주범으로 지목한 **P2(데몬 중복)는 현재 배포에 해당하지 않으며**, 실제 원인은 **P1(요청당 비용 11배) × P10(Done 83개까지 전량 조회)** 두 축이다.

| ID | 문제 | 심각도 | 성격 |
|---|---|---|---|
| P1 | 중첩 PR의 `labels`/`assignees`가 요청 비용을 **1 → 11pt로 11배** 증폭 (실측) | 🔴 Critical | 쿼리 설계 |
| P10 | 상태와 무관하게 **보드 전량** 조회 (운영 보드 92%가 Done) — **API가 지원함에도** 서버사이드 필터 미사용 | 🔴 Critical | 조회 경로 |
| P2 | 리포별 데몬 = 동일 보드 N회 조회 — **현재 배포에는 미해당**, 확장 시 리스크 | 🟡 Medium | 배치 구조 |
| P3 | 어드바이저리 코멘트 무한 페이징 (매 사이클, 변경 없어도) | 🟠 High | N+1 |
| P4 | 실제 point 비용 관측 불가 | 🟠 High | 관측성 |
| P5 | `fetchIssueStatesByIds` 내부 N+1 (순차, 최악 100 왕복) | 🟡 Medium | N+1 |
| P6 | `fetchPriorityOptionOrder` 매 사이클 재조회 | 🟡 Medium | 캐싱 |
| P7 | 403/429·`Retry-After` 처리 부재 | 🟡 Medium | 복원력 |
| P8 | `tool-github-graphql`이 rate-limit 가드 없이 같은 버킷 소비 | 🟡 Medium | 예산 누수 |
| P9 | 아카이브된 보드 아이템의 stale state 유지 | ⚪ Low | 정합성 |

---

## 1. 문제

### 🔴 P1. 중첩 PR 필드가 요청 비용을 11배 증폭 (실측)

- **파일**: [`packages/tracker-github/src/adapter.ts:1691`](../packages/tracker-github/src/adapter.ts) (`PROJECT_ITEMS_QUERY`), 중첩 위치 [`adapter.ts:1810`](../packages/tracker-github/src/adapter.ts) `PullRequestMetadata` fragment, 페이지 크기 [`adapter.ts:10`](../packages/tracker-github/src/adapter.ts) `DEFAULT_PAGE_SIZE = 25`
- **실측 (`first: 25` 고정, 필드 구성만 변경)**:

  | 쿼리 구성 | 실측 cost |
  |---|---|
  | `items` + `content { id }` 만 | **1** |
  | + `blockedBy(first: 100)` | **1** |
  | 현행 전체 (중첩 PR `labels`/`assignees` 포함) | **11** |
  | 현행에서 중첩 PR `labels`/`assignees` 만 제거 | **1** |

- **핵심**: 비용 증가분 10pt가 **전부 `closedByPullRequestsReferences` 안에 중첩된 `labels(20)`/`assignees(20)`**에서 나온다. 이 두 필드는 오케스트레이터의 어떤 판단에도 쓰이지 않고 워커 템플릿 변수로만 전달된다(§2 R1).
- **초판 정정**: `blockedBy(first: 100)`을 주요 비용원으로 지목했으나 **실측 결과 기여도 0**이다. 제거 대상이 아니다.
- **영향**: 운영 보드(90 아이템) = 4페이지 × 11pt = **44 pt/cycle**. 30초 폴링 시 **5,280 pt/hr — 한도 5,000의 106%로 초과**. 이 항목 하나만 고쳐도 9.6%로 떨어진다(부록 A-1).

> **`pageSize` 증가는 비용 중립이다 — 실측 확인.** `first:` 10/25/50/100에 대해 cost 4/11/22/44로 선형이다. 즉 100개를 1요청(44) = 25개를 4요청(4×11=44). 총합이 정확히 같으므로 지연시간만 개선된다.

### 🔴 P10. 상태와 무관하게 보드 전량을 무거운 쿼리로 조회

- **파일**: [`adapter.ts:495-538`](../packages/tracker-github/src/adapter.ts) `fetchProjectIssues`의 per-item `flatMap`, 상태 필터링 위치 [`service.ts:1323`](../packages/orchestrator/src/service.ts) `resolveActionableCandidates`
- **근거**: `fetchProjectIssues`가 적용하는 필터는 **content type · `assignedOnly` · `repositoryFilter` 3개뿐이고 state 필터가 없다.** 상태 판별은 전량을 받아온 **뒤** 로컬에서 수행된다. 즉 Backlog·Done 등 절대 픽업되지 않을 아이템까지 P1의 무거운 fragment(아이템당 ~980 nodes)로 조회한다.
- **⚠️ 초판 정정 — API 제약은 더 이상 존재하지 않는다.** 초판은 [`adr/2026-03-19`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md)를 근거로 "Project V2는 query-time 필터를 제공하지 않는다"고 서술했으나, **2026-07-19 라이브 스키마 introspection 결과 `ProjectV2.items`에 `query: String` 인자가 존재한다.** ADR 작성 시점 이후 GitHub이 추가한 것으로 보인다.

  ```
  items(first:, after:, before:, last:, orderBy:, archivedStates:, query:)
                                                   ↑ "Search query for filtering items"
  ```

- **실측 검증** (61 아이템 보드, Status 옵션 `Backlog / Ready / In progress / In review / Land / Done`):

  | `query` 인자 | 반환 수 |
  |---|---|
  | (없음) | 61 |
  | `status:Backlog` | 8 |
  | `status:Done` | 53 |
  | `-status:Done` | **8** |
  | `-status:Done,Backlog` | 0 |
  | `is:open` / `is:issue` | 8 / 56 |
  | `status:NoSuchState` | **0 (에러 아님)** ⚠️ |

  `8 + 53 = 61`로 정합하며, 부정(`-`)·다중값·`is:` 한정자 모두 동작한다.

- **영향**: 비용이 **actionable 후보 수가 아니라 보드 전체 크기**에 비례한다. Done이 누적될수록 단조 증가하며 상한이 없다. **운영 보드는 90개 중 83개(92%)가 Done**이며, `-status:Done`은 7개다 — 필터만 적용해도 4페이지 → 1페이지가 된다.
- **⚠️ 도입 시 함정**: `status:NoSuchState`는 **에러가 아니라 빈 결과**를 반환한다. 긍정 필터(`status:Ready,...`)를 쓰면 보드에서 Status 옵션 이름이 바뀌는 순간 오케스트레이터가 **조용히 전체 디스패치를 중단**한다. 대응은 §2 R1.5 참조.

### 🟡 P2. 리포별 데몬 = 동일 보드 N회 조회 (현재 배포 미해당)

> **2026-07-19 실측으로 격하.** 초판은 이를 주범으로 지목했으나, 확인 결과 **실행 중인 오케스트레이터는 1대뿐**이다(PID 42112, `gh-symphony repo start --assigned-only`, cwd `/Users/steve/Projects/ioa-tracker`, 2026-07-17 기동). 단일 프로젝트·단일 리포 구성이므로 중복 조회는 발생하지 않는다.
>
> 아래 구조적 분석은 **다중 리포로 확장할 때** 유효하므로 기록을 유지한다.


- **파일**: [`service.ts:638`](../packages/orchestrator/src/service.ts) `reconcileProject`, [`orchestrator-adapter.ts:196`](../packages/tracker-github/src/orchestrator-adapter.ts) `resolveRepositoryFilter`, [`adapter.ts:512`](../packages/tracker-github/src/adapter.ts) `isIssueInRepository`
- **근거**: `OrchestratorService` 인스턴스 하나 = 프로젝트 설정 하나 = Project V2 보드 하나. 리포 스코핑은 **보드 전체를 가져온 뒤 클라이언트에서 필터링**한다. `resolveRepositoryFilter`는 `tracker.settings.repository`가 미설정이면 `project.repository` 기준 필터를 반환하며, 리터럴 `"*"`만 이를 비활성화한다.
- **영향**: 리포 N개를 데몬 N개로 운영하면 **동일한 보드 전체를 매 사이클 N번** 가져온다. 소비량이 리포 수에 선형 비례한다면 원인은 한도 부족이 아니라 배치 구조다.
- **✅ 확인 완료 (§4-1)**: 현재 배포는 데몬 1대·단일 리포이므로 **이 문제는 발현되지 않는다.** 다중 리포 확장 시 재검토 대상.

### 🟠 P3. 어드바이저리 코멘트 무한 페이징

- **파일**: [`service.ts:1394`](../packages/orchestrator/src/service.ts) `publishLinkedPullRequestActiveAdvisories`, [`adapter.ts:732`](../packages/tracker-github/src/adapter.ts) `upsertIssueComment`, [`adapter.ts:785`](../packages/tracker-github/src/adapter.ts) `findIssueCommentByMarker`
- **근거**: 필터된 이슈를 **순차 루프**하고, 각 이슈마다 `findIssueCommentByMarker`가 마커를 찾을 때까지 100개씩 코멘트를 페이징한다. 찾은 코멘트 id를 사이클 간에 캐시하지 않는다.
- **영향**: 코멘트 500개가 달린 이슈는 "변경 없음"을 확인하기 위해 **30초마다 5요청**을 영구히 소비한다. 이슈 수 × 코멘트 수에 비례해 증가하며, 상한이 없다.

### 🟠 P4. 실제 point 비용 관측 불가

- **파일**: [`adapter.ts:1629`](../packages/tracker-github/src/adapter.ts) `extractGitHubRateLimits`
- **근거**: rate limit 정보를 **응답 헤더에서만** 파싱한다(`x-ratelimit-*`). GraphQL `rateLimit { cost remaining }` 필드는 **어떤 쿼리에서도 요청하지 않는다.**
- **영향**: 어느 쿼리가 얼마를 쓰는지 런타임에서 알 수 없다. 본 조사는 `gh api graphql`로 외부에서 측정해 우회했으나, **운영 중 회귀 감지·튜닝 효과 검증은 여전히 불가능**하다. 초판의 비용 추정이 22배 빗나간 것도 이 관측 공백 때문이다.
- **참고 (기존 방어 로직은 있음)**: [`adapter.ts:1592`](../packages/tracker-github/src/adapter.ts) `guardGraphQLRateLimit`이 잔여 100 이하일 때 reset까지 대기(최대 60초, [`adapter.ts:14`](../packages/tracker-github/src/adapter.ts)), [`service.ts:3589`](../packages/orchestrator/src/service.ts) `resolveAdaptivePollIntervalMs`가 잔여 50% 미만에서 폴링 간격을 최대 10배까지 늘린다. 즉 **한도 소진을 완화하는 장치는 있으나, 소진 자체를 줄이지는 못한다.**

### 🟡 P5. `fetchIssueStatesByIds` 내부 N+1

- **파일**: [`adapter.ts:609`](../packages/tracker-github/src/adapter.ts), [`adapter.ts:1172`](../packages/tracker-github/src/adapter.ts) `resolveIssueProjectItemForStateLookup`
- **근거**: 반환 노드마다 `await resolveIssueProjectItemForStateLookup(...)`을 **순차** 호출하고, 대상 프로젝트가 해당 이슈의 `projectItems` 첫 100개에 없으면 `ISSUE_PROJECT_ITEMS_PAGE_QUERY`를 추가 발행한다.
- **영향**: 최악의 경우 배치당 100회 직렬 왕복. 요청당 비용은 낮으나 지연이 누적된다.

### 🟡 P6. `fetchPriorityOptionOrder` 매 사이클 재조회

- **파일**: [`adapter.ts:476`](../packages/tracker-github/src/adapter.ts), [`adapter.ts:1429`](../packages/tracker-github/src/adapter.ts)
- **근거**: `priorityFieldName`이 설정되어 있으면 매 `listIssues` 호출마다 `PROJECT_FIELDS_QUERY`를 재발행한다. 프로젝트 필드 정의는 사실상 변하지 않는다.
- **영향**: 영구적인 +1 요청/사이클. 개별 비용은 작다(`fields(first: 100)`).

### 🟡 P7. 403/429 · `Retry-After` 처리 부재

- **파일**: [`adapter.ts:1560`](../packages/tracker-github/src/adapter.ts)
- **근거**: 비 2xx 응답은 전부 `GitHubTrackerHttpError`로 throw하고, 사이클 catch([`service.ts:429`](../packages/orchestrator/src/service.ts))가 로깅 후 다음 폴링을 기다린다. 재시도·지수 백오프·`Retry-After` 준수가 없다.
- **영향**: secondary rate limit 403을 인증 실패와 구분할 수 없다. 디스패치 억제는 정확히 `"Rate limit near exhaustion"` 문자열에만 반응한다([`service.ts:3654`](../packages/orchestrator/src/service.ts)).

### 🟡 P8. `tool-github-graphql`의 예산 누수

- **파일**: [`packages/tool-github-graphql/src/tool.ts:25`](../packages/tool-github-graphql/src/tool.ts) `executeGitHubGraphQL`
- **근거**: 헤더 파싱·rate-limit 가드·재시도가 **전혀 없다.** MCP 툴([`mcp-server.ts:22`](../packages/tool-github-graphql/src/mcp-server.ts))과 CLI로 에이전트에 노출된다.
- **영향**: 에이전트가 턴당 무제한으로 호출할 수 있고, 그 소비량이 오케스트레이터의 rate-limit 회계 **바깥에서** 동일한 계정 버킷을 잠식한다. 오케스트레이터가 예산을 정확히 관리해도 워커 쪽에서 소진될 수 있다.

### ⚪ P9. 아카이브된 보드 아이템의 stale state

- **파일**: [`adapter.ts:1863`](../packages/tracker-github/src/adapter.ts) (`includeArchived: false`), `PROJECT_ITEMS_QUERY`([`adapter.ts:1691`](../packages/tracker-github/src/adapter.ts)), [`service.ts:1911`](../packages/orchestrator/src/service.ts)
- **⚠️ 초판 정정**: 초판은 "`PROJECT_ITEMS_QUERY`에는 아카이브 필터가 없어 by-ids 경로와 비대칭"이라고 서술했으나, **실측 결과 `items()`의 `archivedStates` 기본값이 `NOT_ARCHIVED`다.** 따라서 **양쪽 경로 모두 아카이브 아이템을 제외**하며 비대칭은 존재하지 않는다.

  ```
  (기본값)                          → 61
  archivedStates:[ARCHIVED]         → 0
  archivedStates:[ARCHIVED,NOT_ARCHIVED] → 61
  ```

- **근거**: active run의 보드 아이템이 아카이브되면 **두 경로 모두에서 사라진다.** `normalizeIssueStateLookupNode`가 `null`을 반환([`adapter.ts:992`](../packages/tracker-github/src/adapter.ts))하고 `currentTrackerState`가 undefined가 되어 run이 **변경 없이 통과**한다.
- **영향**: `issueState`가 조용히 stale 상태로 유지된다. **R3로는 해소되지 않는다**(초판 서술 정정) — 아카이브를 명시적 상태 전이로 다루려면 `archivedStates:[ARCHIVED,NOT_ARCHIVED]` + `isArchived` 조회가 필요하다.

---

## 2. 제안하는 해결방안

절감 효과 대비 리스크 순으로 정렬했다. **R1과 R2만으로 대부분 해결될 가능성이 높다.**

### R0. `rateLimit { cost remaining }` 계측 추가 — **선행 필수**

- **대상**: 전 GraphQL 쿼리, 특히 `PROJECT_ITEMS_QUERY`
- **작업량**: 매우 작음 (쿼리에 필드 추가 + 응답 파싱)
- **효과**: 절감 0. 그러나 **이후 모든 변경의 효과를 추정이 아닌 측정으로 만든다.** 이것 없이 튜닝하면 전부 추측이다.
- **리스크**: 없음

### R1. `PROJECT_ITEMS_QUERY`에서 중첩 PR의 `labels`/`assignees` 제거 — **최대 효과**

- **대상**: [`adapter.ts:1810`](../packages/tracker-github/src/adapter.ts) `PullRequestMetadata` fragment 내부의 `labels(first:20)` / `assignees(first:20)`
- **효과 (실측)**: 요청당 **cost 11 → 1 (11배 절감)**. 초판 추정(5.4배)보다 오히려 크다. 전 조치 중 **단위 작업량 대비 효과가 가장 좋다** — 필드 2개 삭제로 11배
- **리스크**: 낮음. 이 두 필드를 읽는 **오케스트레이터 판단 로직이 없다.** [`render.ts:92`](../packages/core/src/workflow/render.ts)를 거쳐 워커 템플릿 변수로만 전달된다.
- **✅ 선행 확인 완료 (§4-2)**: 실제 워크플로 템플릿 중 `linked_pull_requests[].labels` / `.assignees`를 참조하는 것은 **하나도 없다.** 참조는 테스트 픽스처 4곳뿐이며 그마저도 `pr.number`/`pr.state` 등만 쓴다. **축소 절충 없이 완전 제거 가능**하며, 렌더링되는 프롬프트는 하나도 바뀌지 않는다.
- **⚠️ 함께 건드리면 안 되는 것**:
  - `blockedBy(first: 100)` — [`explain.ts:542`](../packages/orchestrator/src/explain.ts) `issueHasBlockingDependency`가 dispatch 적격성 판정에 사용. **게다가 실측 비용 기여도가 0이므로 건드릴 이유 자체가 없다**
  - `closedByPullRequestsReferences` **본체** — [`service.ts:252`](../packages/orchestrator/src/service.ts) `resolvePullRequestBranchCheckoutTarget`이 `headRefName` 부재 시 throw. PR/이슈 dedup([`service.ts:170`](../packages/orchestrator/src/service.ts))도 여기에 의존

### R1.5. `items(query:)` 서버사이드 필터 적용 — 페이지 수 절감

- **대상**: [`adapter.ts:1691`](../packages/tracker-github/src/adapter.ts) `PROJECT_ITEMS_QUERY`에 `query` 변수 추가, [`adapter.ts:691`](../packages/tracker-github/src/adapter.ts) `fetchProjectItemsPage`에서 전달
- **효과**: **요청당 cost는 변하지 않는다**(cost는 반환 행 수가 아니라 요청한 `first:` 값으로 산정됨 — 실측 확인). 절감은 **페이지 수 감소**에서 나온다. 측정 보드 기준 61개 → 8개 = **3페이지 → 1페이지 (3배)**. Done 비율이 높을수록 커지며, 실무 보드는 대개 Done이 대다수다.
- **R1과의 관계**: 서로 다른 축이므로 **곱해진다.** R1은 요청당 cost(11→1), R1.5는 요청 수(3→1).
- **⚠️ 필터 표현식 선택 — 안전성이 갈린다**:

  | 방식 | 평가 |
  |---|---|
  | `-status:Done,<기타 terminal>` (부정) | **권장.** 새 상태가 추가되어도 누락되지 않고 포함된다. 실패 시 과다 조회(안전) |
  | `status:Ready,"In progress",...` (긍정) | **비권장.** 옵션 이름 변경 시 **에러 없이 0건** 반환 → 디스패치 전면 중단(P10 참조) |

  긍정 필터를 쓴다면, 이미 존재하는 `PROJECT_FIELDS_QUERY`([`adapter.ts:1825`](../packages/tracker-github/src/adapter.ts))로 옵션 이름을 **읽어 검증한 뒤** 표현식을 조립하고, 불일치 시 **fail-loud** 해야 한다.

- **⚠️ 필터에서 반드시 제외하면 안 되는 집합**: 필터가 active run의 이슈를 떨어뜨리면 [`service.ts:906`](../packages/orchestrator/src/service.ts) suppression 분기가 **정상 워커를 SIGTERM으로 종료**한다(R3와 동일한 함정). terminal 상태를 배제하는 부정 필터는 이 위험이 낮지만, active run의 상태 집합이 필터를 통과하는지 반드시 검증할 것.
- **리스크**: 중간. 필터 표현식이 조용히 실패하는 특성 때문에, 도입 시 **필터 적용 전후 건수 비교 로깅**을 함께 넣기를 권장한다.
- **관련**: [`adr/2026-03-19`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md)의 전제("API가 state 필터를 제공하지 않는다")가 무효화되었으므로 **해당 ADR을 supersede** 해야 한다.

> **초판의 2단계 페치(얇은 스윕 + 선별 상세) 안은 격하되었다.** 서버사이드 필터로 동일 효과를 훨씬 적은 복잡도로 얻을 수 있다. 필터 적용 후에도 보드가 충분히 크다면(수천 건) 재검토 가치가 있다.

### R2. 어드바이저리 코멘트를 REST + ETag로 전환

- **대상**: [`adapter.ts:785`](../packages/tracker-github/src/adapter.ts) `findIssueCommentByMarker`
- **방식**: 마커 탐색은 최초 1회만 수행하고 코멘트 id를 영속화 → 이후 `GET /repos/{owner}/{repo}/issues/comments/{id}` + `If-None-Match`
- **효과**: **REST의 304 응답은 rate limit을 소모하지 않는다.** 변경이 없는 대다수 사이클에서 비용이 사실상 0이 된다. 추가로 REST는 GraphQL과 **완전히 별개인 5,000 요청/hr 버킷**을 쓰므로, 이관 자체가 GraphQL 예산을 비운다.
- **리스크**: 낮음~중간. 코멘트 id 영속화 위치 설계 필요(run 스냅샷 또는 별도 상태 파일)

### R3. active run 상태 동기화 통합 — **전제 리팩터링 필요**

- **대상**: [`service.ts:1882`](../packages/orchestrator/src/service.ts) `syncActiveRunIssueStates`
- **⚠️ 단순 삭제하면 깨진다.** 적대적 검증 결과, `fetchIssueStatesByIds`는 필드 중복이 아니라 **"필터를 적용하지 않고 모든 active run id로 호출된다"**는 속성이 load-bearing이다:
  - `reconcileProject`가 `issueIdentifier`와 함께 호출되면 [`service.ts:710`](../packages/orchestrator/src/service.ts)에서 `filteredIssues`가 해당 이슈 하나로 좁혀진다
  - 그러나 suppression 루프([`service.ts:893`](../packages/orchestrator/src/service.ts))는 **모든** claimed run을 순회한다
  - 지금 두 번째 쿼리를 제거하면 → 지목되지 않은 active run이 조회 실패 → [`service.ts:906`](../packages/orchestrator/src/service.ts) 분기 → **정상 워커에 SIGTERM**, run이 `"tracker issue is no longer tracked"`로 suppressed
  - `--assigned-only` 중 재할당된 이슈([`adapter.ts:507`](../packages/tracker-github/src/adapter.ts))·타 리포로 transfer된 이슈([`adapter.ts:512`](../packages/tracker-github/src/adapter.ts))도 같은 경로로 종료된다
- **올바른 순서**: ① suppression 루프 이전에 `filteredIssues`를 좁히지 않도록 리팩터링 → ② 두 번째 쿼리 제거
- **효과**: 사이클당 요청 1건(+N+1 꼬리) 제거. **실측 기준 절감폭이 작다** — R1/R1.5가 이미 44배를 확보하므로 rate limit 관점에서는 후순위다. 실행 근거는 절감보다 **중복 제거·P9 정합성**에 있다.
- **부수 효과 (정정)**: 초판은 P9(아카이브 stale state)가 함께 해소된다고 했으나, `archivedStates` 기본값 실측(§1 P9)에 따라 **해소되지 않는다.** 아카이브 대응은 별도 조치가 필요하다
- **관련 ADR**: [`adr/2026-03-19_github-project-v2-state-filtering-cache.md`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md) — 이 경로는 #60에서 의도적으로 도입된 것이므로, 변경 시 해당 ADR을 supersede 해야 한다

### R4. 데몬 배치를 프로젝트 단위로 통합

- **조건**: P2가 실제 운영 형태로 확인될 경우에만
- **효과**: 리포 수에 비례한 중복이 그대로 제거된다. 리포 5개면 **5배 절감**
- **리스크**: 배포/운영 절차 변경. 코드 변경은 최소

### R5. `fetchPriorityOptionOrder` 결과 캐싱

- **대상**: [`adapter.ts:476`](../packages/tracker-github/src/adapter.ts)
- **효과**: 작음(+1 요청/사이클 제거). 프로세스 수명 캐시로 충분
- **캐시 정책**: API URL·프로젝트 ID별 필드 목록 조회 성공 결과를 프로세스 수명 동안 재사용하고, 필드 이름별 옵션 순서는 캐시된 목록에서 계산한다. 조회 실패는 캐시하지 않아 다음 호출에서 재시도한다.
- **리스크**: 낮음. 실행 중 필드를 생성·삭제하거나 옵션을 변경해도 데몬을 재시작하기 전까지는 반영되지 않는다.

### R6. 403/429 · `Retry-After` 처리 추가

- **대상**: [`adapter.ts:1560`](../packages/tracker-github/src/adapter.ts)
- **효과**: 절감이 아닌 **복원력**. secondary rate limit을 인증 실패와 구분하고 지수 백오프로 회복
- **리스크**: 낮음

### R7. `tool-github-graphql`에 rate-limit 가드 적용

- **대상**: [`tool.ts:25`](../packages/tool-github-graphql/src/tool.ts)
- **효과**: 에이전트 호출을 오케스트레이터 예산 회계에 편입. `adapter.ts`의 `guardGraphQLRateLimit`을 공유 유틸로 추출해 재사용
- **리스크**: 낮음

### R8. GitHub App 전환 — 후순위

- **전제**: R1~R4를 수행하고도 부족하고, **리포지토리가 여러 org에 분산된 경우에만** 실효가 있다
- **이유**: rate limit 버킷은 **installation 단위**로 분리된다. 리포가 전부 한 org에 있으면 installation도 하나이므로 버킷 배수 효과가 없다(org 규모에 따른 스케일업은 있음)
- **공개 URL 불필요**: installation token 흐름은 전부 outbound(JWT 서명 → `POST /app/installations/{id}/access_tokens` → GraphQL 호출)다. webhook을 쓰지 않으면 공개 엔드포인트가 필요 없다
- **전환 시 블로커**:

  | 이슈 | 위치 | 내용 |
  |---|---|---|
  | `GET /user` 403 | [`adapter.ts:823`](../packages/tracker-github/src/adapter.ts) `fetchCurrentUserLogin` | installation token으로 호출 불가. `assignedOnly` 사용 시 즉시 실패 |
  | `viewer` 쿼리 | [`client.ts:848`](../packages/cli/src/github/client.ts), [`client.ts:869`](../packages/cli/src/github/client.ts) | 부트스트랩/프로젝트 탐색 경로 실패 (데몬 루프는 무관) |
  | user-owned 프로젝트 | — | Project V2가 개인 계정 소유면 **도달 불가**. org 소유 이전 필요 |
  | 토큰 회전 시 캐시 churn | [`adapter.ts:1625`](../packages/tracker-github/src/adapter.ts) `fingerprintToken`, [`orchestrator-adapter.ts:254`](../packages/tracker-github/src/orchestrator-adapter.ts) `hashToken` | 캐시 키가 **토큰 값** 기반. 1시간마다 만료되는 토큰에서는 갱신 때마다 rate-limit 캐시·project-items 캐시가 전부 무효화된다. **전환 시 최우선 수정 대상** |

- **재사용 가능한 기반**: [`tool.ts:62`](../packages/tool-github-graphql/src/tool.ts) `resolveGitHubGraphQLToken`이 이미 `{ token, expiresAt }` 브로커 패턴을 구현하고 있다(캐시 파일 0600, 60초 재사용 윈도우). 트래커는 이를 쓰지 않고 정적 `token: string`을 가정하므로([`adapter.ts:18`](../packages/tracker-github/src/adapter.ts)), `token: string | (() => Promise<string>)`로 확장하면 된다

---

## 3. 검토했으나 채택하지 않은 방안

| 방안 | 기각 사유 |
|---|---|
| **리포/환경마다 PAT 분리** | 효과 없음. primary rate limit은 토큰이 아닌 **계정** 단위. 같은 계정의 PAT N개는 동일한 5,000pt 버킷을 공유한다 |
| **machine user 계정 다중 생성** | 계정별 버킷 분리는 되지만 한도 회피 목적의 계정 다중 생성은 GitHub ToS 위반 소지가 있고 seat 비용이 발생한다 |
| **`pageSize` 25 → 100 증가** | **비용 중립 — 실측 확인** (`first:` 10/25/50/100 → cost 4/11/22/44 선형). 지연시간만 개선되므로 R1.5와 함께라면 고려 가능 |
| **Project V2 조회 전체를 REST로 이관** | **불가능.** Project V2는 REST API가 없다. 보드 아이템·필드 값·status는 GraphQL에 남아야 한다 |
| ~~**서버사이드 state 필터링**~~ | **기각 철회 — 채택.** 초판은 API 미지원으로 기각했으나 실측 결과 `items(query:)`가 지원된다. **R1.5로 승격**. [`adr/2026-03-19`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md)는 supersede 대상 |
| **2단계 페치(얇은 스윕 + 선별 상세)** | 서버사이드 필터로 더 적은 복잡도로 동등 효과 달성 가능. 필터 적용 후에도 보드가 수천 건 규모라면 재검토 |

---

## 4. 확인 항목 — 전건 해소 완료

**초판의 미해결 항목은 2026-07-19 조사로 전부 해소되었다.** 이슈 발행에 필요한 전제는 남아 있지 않다.

| # | 항목 | 결과 |
|---|---|---|
| 1 | 운영 배포가 리포별 데몬 형태인가? | ✅ **아니오.** 데몬 1대(PID 42112, `repo start --assigned-only`, cwd `/Users/steve/Projects/ioa-tracker`, 2026-07-17 기동), 단일 프로젝트·단일 리포. **P2는 현재 원인이 아님 → 🟡로 격하** |
| 2 | 템플릿이 `linked_pull_requests[].labels`/`.assignees`를 참조하는가? | ✅ **아니오. R1은 안전.** 아래 상세 |
| 3 | `items()`가 아카이브 아이템을 반환하는가? | ✅ **해소.** `archivedStates` 기본값 = `NOT_ARCHIVED` 실측 확인. 양 경로 대칭(§1 P9 정정) |
| 4 | `items()`에 필터 인자가 추가되었는가? | ✅ **`query: String` 지원 확인.** ADR supersede 필요 (§1 P10) |
| 5 | `service.ts:734-745`가 죽은 코드인가? | ✅ **확인.** 아래 상세 |
| 6 | 잔여량을 소비한 주체는? | ✅ **실행 중인 단일 데몬.** `used=3419` 관측치가 계산값(5,280 pt/hr)과 부합 |
| 7 | 실측 보드가 운영 보드를 대표하는가? | ✅ **운영 보드 직접 측정으로 대체.** 부록 A-1은 실제 폴링 대상 보드(90 아이템) 기준 |

**#2 상세 — R1의 리스크는 0으로 확인되었다.**
`linked_pull_requests`는 PR 객체 전체가 전달되며([`render.ts:111`](../packages/core/src/workflow/render.ts), `TrackedPullRequestContext`의 index signature로 `labels`/`assignees`가 보존됨), 따라서 템플릿이 `pr.labels`를 명시하면 접근 가능하다. 그러나 **암묵적 누출은 불가능하다** — Liquid/legacy 양 경로 모두 객체를 JSON 직렬화하지 않고 `[object Object]`를 출력한다([`render.ts:194`](../packages/core/src/workflow/render.ts), [`render.ts:261`](../packages/core/src/workflow/render.ts)에서 배열 skip).

전수 조사 결과 **실제 워크플로 템플릿은 PR 변수를 전혀 쓰지 않는다.** 참조는 테스트 픽스처 4곳뿐이다([`render.test.ts:99,104,212`](../packages/core/src/workflow/render.test.ts), [`service.test.ts:3851`](../packages/orchestrator/src/service.test.ts)) — 모두 `pr.number`/`pr.state`/`pr.identifier`/`pr.projectState`만 사용하며 `labels`/`assignees`는 없다. `ioa-tracker/WORKFLOW.md`는 line 55에서 **호환성을 위해 `pull_request_context` 변수를 의도적으로 쓰지 않는다고 명시**하고 있다.

→ **제거해도 렌더링되는 프롬프트가 하나도 바뀌지 않는다.** 축소(`first: 5`) 절충이 불필요하며 완전 제거가 가능하다. 향후 서드파티 `WORKFLOW.md`가 `{{ pr.labels }}`를 쓰면 `strictVariables: true`([`render.ts:187`](../packages/core/src/workflow/render.ts))로 인해 **조용히 실패하지 않고 throw**하므로 회귀는 명시적으로 드러난다.

**#5 상세 — 죽은 코드가 맞으나, 삭제 시 주석이 필요하다.**
[`service.ts:723`](../packages/orchestrator/src/service.ts)의 시딩이 무조건적이고 loop 1은 `.set()`만 하므로, loop 2의 `!existing` 분기는 **도달 불가**다. else 분기도 값 보존적이다(유일한 차이는 `rateLimits`의 `undefined → null` 강제이며, 소비처가 둘을 동일 취급하므로 무해).

다만 **loop 2의 spread 순서가 loop 1과 반대**(`{...synced, ...existing}` vs `{...existing, ...fresh}`)라는 점은 짚어둘 만하다. 두 루프가 서로 다른 시점에 다른 가정 하에 작성됐을 가능성을 시사하며, 723줄 시딩이 조건부로 바뀌면 loop 2가 다시 살아나 의도한 우선순위를 지키게 된다. **삭제 시 "723줄 시딩이 무조건적이므로 불필요"라는 불변식을 주석으로 남길 것.** — 723줄에서 이미 맵을 시드하므로 736줄 `!existing` 분기에 도달 불가로 보인다. 향후 재배치를 대비한 방어 코드일 가능성을 배제하지 못함

---

## 부록 A. 사이클당 예산 개요

이슈 I개, active run A개, 페이지 P = ⌈I/25⌉ 기준:

```
listIssues                    P 요청 × 11pt (실측)     ← P1 × P10, 지배적
fetchPriorityOptionOrder      +1 요청 (priorityFieldName 설정 시)  ← P6
fetchCurrentUserLogin         +1 REST (assignedOnly 시)
fetchIssueStatesByIds         ⌈A/100⌉ + 최대 A 추가 (N+1)          ← P5
어드바이저리 upsert            이슈당 ⌈comments/100⌉ 읽기 + 0~1 mutation  ← P3
──────────────────────────────────────────────────────────────
기본 30초 주기. 잔여 50% 미만에서 최대 10배까지 간격 확장
```

### A-1. 운영 보드 실측 (결론의 근거)

**대상**: `PVT_kwDOBB0_W84BRapW` "유지보수 서비스 프로젝트" — 실행 중인 데몬이 실제로 폴링하는 보드

| 항목 | 값 |
|---|---|
| 전체 아이템 | **90** |
| 상태 분포 | Done **83 (92%)** / Ready 4 / In progress 2 / In review 1 / Backlog 0 |
| `-status:Done` | **7** |
| `pageSize` (`DEFAULT_PAGE_SIZE`) | 25 → **4 페이지** |
| 폴링 주기 | 30,000ms (`WORKFLOW.md` `polling.interval_ms`) → **120 cycle/hr** |
| 요청당 실측 cost | **11** (현행) / **1** (R1 적용) |

| 시나리오 | cost/req | 페이지 | pt/cycle | pt/hr | 한도(5,000) 대비 |
|---|---|---|---|---|---|
| **현재** | 11 | 4 | **44** | **5,280** | **106% — 초과** |
| R1만 (중첩 필드 제거) | 1 | 4 | 4 | 480 | 9.6% |
| R1.5만 (`-status:Done`) | 11 | 1 | 11 | 1,320 | 26% |
| **R1 + R1.5** | 1 | 1 | **1** | **120** | **2.4% (44배 절감)** |

**해석 — 초판과 결론이 완전히 다르다:**

1. **데몬 1대, 리포 1개로 이미 106% 초과다.** "여러 리포지토리를 오케스트레이션할 때"는 조건이 아니라 증상을 앞당긴 요인일 뿐이다.
2. **P2(데몬 중복)는 현재 배포의 원인이 아니다** — 데몬은 1대뿐이다. 실제 원인은 **P1 × P10**.
3. **P10의 비중이 초판 예상보다 훨씬 크다.** 보드의 **92%가 Done**이므로, 매 30초마다 절대 픽업되지 않을 83개를 무거운 쿼리로 조회하고 있다.
4. **R1 단독으로 106% → 9.6%**가 되어 즉시 해소된다. 필드 2개 삭제로. **최우선 착수 대상.**
5. R1 + R1.5는 44배(2.4%)를 확보하며, 향후 다중 리포 확장(P2)까지 흡수한다.

**관측된 실제 소비**: 측정 시점 `used=3419 / limit=5000 / remaining=1581`(reset 07:13Z). 본 조사 쿼리 소비분(~130pt)을 제외한 대부분이 실행 중인 데몬의 소비로, 위 계산과 부합한다.

**주의**: 위는 `listIssues` 경로만 계산한 것이다. P3(어드바이저리 코멘트 페이징)은 이슈·코멘트 수에 비례해 **별도로** 누적되며 상한이 없다. `--assigned-only` 구동이므로 `fetchCurrentUserLogin`의 REST 호출도 매 사이클 발생한다(별도 REST 버킷). 또한 P8(`tool-github-graphql`)의 에이전트 호출은 이 회계 **바깥에서** 같은 GraphQL 버킷을 소비한다.

## 부록 B. 한도 구조 참고

| | 한도 | 단위 | 비고 |
|---|---|---|---|
| REST (PAT) | 5,000 **요청**/hr | 계정 | ETag 304 응답은 미소모 |
| GraphQL (PAT) | 5,000 **point**/hr | 계정 | 요청당 1이 아님 — 노드 수 기반 |
| REST / GraphQL (App installation) | org 규모에 따라 스케일업 | installation | 정확한 상한은 최신 GitHub 문서 확인 필요 |

**REST와 GraphQL은 완전히 별개 버킷이다.** 이관만으로 총 예산이 늘어난다. 다만 실측 결과 GraphQL cost가 예상보다 훨씬 낮으므로(페이지당 11pt), 초판이 강조한 "REST 이관의 비용 우위"는 과장이었다. **REST 이관의 실질 가치는 point 절감이 아니라 ETag 조건부 요청(304 = 무소모)에 있으며**, 이는 P3(어드바이저리 코멘트)에 국한된다.

# ADR: GitHub Project V2 서버사이드 상태 필터와 per-tick cache 계약

- **Date**: 2026-08-01
- **Status**: Accepted
- **Related Issues**: #475
- **Related PRs**: #500, #515 (runtime implementation and contract correction)
- **Supersedes**:
  [`2026-03-19_github-project-v2-state-filtering-cache.md`](./2026-03-19_github-project-v2-state-filtering-cache.md)
- **Related Analysis**:
  [`docs/reports/2026-07-19-github-api-rate-limit-audit.md`](../reports/2026-07-19-github-api-rate-limit-audit.md)
  §2 R1.5
- **Related Spec**: `docs/symphony-spec.md` §8.1, §8.6, §11.1

## Context

2026-03-19 ADR은 GitHub Project V2 GraphQL API가 project item을 상태로
query-time filtering할 수 없다는 전제 아래 다음 두 결정을 함께 내렸다.

1. `listIssuesByStates()`가 전체 project item을 조회한 뒤 로컬에서 상태를
   필터링한다.
2. 같은 poll tick 안의 중복 전체 조회를 줄이기 위해 `projectItemsCache`를
   공유한다.

2026-07-19 live schema introspection에서 `ProjectV2.items`에 `query: String`
인자가 존재함을 확인했고, 실제 보드에서도 다음 표현식이 동작했다.

- `status:Ready`
- `status:Ready,"In progress"`
- `-status:Done`
- `is:open`, `is:issue`

따라서 “서버사이드 필터가 불가능하다”는 전제는 더 이상 유효하지 않다.
완료 상태가 누적된 보드에서 전체 item을 매 poll마다 페이지네이션하는 것은
불필요한 GraphQL 요청을 만든다.

다만 `status:NoSuchState` 같은 긍정 필터는 오류가 아니라 빈 결과를
반환한다. 상태 옵션의 이름이 바뀌면 정상적인 0건과 configuration drift를
구분할 수 없어 dispatch가 조용히 중단될 수 있다. 또한 candidate listing과
startup terminal cleanup은 필요한 상태 집합이 서로 다르므로 동일한 필터
snapshot을 항상 공유할 수도 없다.

## Affected Symphony Layers

| Layer         | 영향     | 설명                                                                        |
| ------------- | -------- | --------------------------------------------------------------------------- |
| Policy        | Yes      | candidate 조회에 안전한 부정 필터를 우선하는 원칙을 정한다.                 |
| Integration   | Yes      | GitHub Project V2 adapter의 `items(query:)`와 cache identity를 정의한다.    |
| Configuration | No       | 기존 workflow lifecycle 설정을 입력으로 사용하며 새 설정을 추가하지 않는다. |
| Coordination  | No       | poll, cleanup, reconciliation 순서와 dispatch 판정은 바꾸지 않는다.         |
| Execution     | No       | worker lifecycle과 workspace 실행 계약은 바꾸지 않는다.                     |
| Observability | Indirect | 필터 query와 전후 item 수를 기존 tracker event로 관찰한다.                  |

이 결정은 GitHub tracker에 한정된 repository-local 구현 선택이다. upstream
Symphony spec의 candidate fetch, terminal-state fetch, normalized output 계약은
변경하지 않는다.

## Decision

### 1. Candidate listing에 서버사이드 필터를 채택한다

`listIssues()`의 candidate snapshot은 `ProjectV2.items(query:)`로 terminal
상태를 서버에서 제외한다. 반환된 item에는 기존 content type, assignee,
repository 필터와 최종 lifecycle 판정을 계속 적용한다. 서버 필터는 전송량과
페이지 수를 줄이는 사전 필터이며 dispatch 적격성의 유일한 판정자가 아니다.

현재 GitHub query 문법의 상태 qualifier는 `status:`이므로 workflow의
`stateFieldName`이 대소문자를 무시하고 `Status`일 때만 서버 필터를 적용한다.
사용자 정의 상태 필드에는 검증되지 않은 query를 만들지 않고 unfiltered
fetch로 안전하게 fallback한다. terminal 상태가 비어 있을 때도 query를
생성하지 않는다.

### 2. 상태 표현식은 부정 필터를 기본으로 한다

표현식은 다음 형태로 만든다.

```text
-status:Done,"Won't do"
```

원칙은 다음과 같다.

- workflow의 terminal 상태만 제외한다.
- 공백이나 특수문자가 있는 값은 quote하고 `\`와 `"`를 escape한다.
- 상태 이름은 trim하고 대소문자 기준으로 중복을 제거한다.
- 같은 상태가 active와 terminal에 동시에 있으면 query를 보내기 전에
  fail-loud한다.
- terminal 상태가 rename되어 filter가 더 이상 일치하지 않으면 item을 더
  많이 가져오는 쪽으로 실패한다. 이후 로컬 lifecycle 판정이 dispatch를
  방어한다.

긍정 allowlist인 `status:Ready,"In progress"`는 기본 전략으로 사용하지
않는다. 옵션 rename 또는 존재하지 않는 상태가 오류 없이 빈 결과가 되어
전체 dispatch를 멈출 수 있기 때문이다. 향후 긍정 필터가 필요해지면 Project
field option을 먼저 조회해 이름을 검증하고 불일치 시 fail-loud하는 별도
결정이 필요하다.

### 3. `projectItemsCache`는 per-tick snapshot cache로 유지한다

cache의 lifetime은 기존 결정대로 단일 poll tick이다. 다음 tick에는 새
cache를 만들어 stale project snapshot을 재사용하지 않는다. startup cleanup과
이후 loop tick도 서로 다른 cache를 사용한다.

cache entry는 “Project 전체 item”이 아니라 **동일한 server filter mode와
normalization 입력으로 만든 snapshot**을 뜻한다. 따라서 key에는 최소한 다음
결과 차원을 구분할 수 있는 입력이 포함되어야 한다.

- Project와 GraphQL endpoint, 인증 주체
- server-side state filter를 결정하는 workflow lifecycle
- 정규화된 terminal-state server filter 활성 여부(query가 `null`이면 동일)
- repository와 assignee scope
- priority normalization 설정
- timeout 등 fetch 결과/동작을 구분해야 하는 adapter 입력

filtered candidate snapshot과 unfiltered state-lookup snapshot은 서로 다른
cache entry다. query 또는 normalization 차원이 다른 호출끼리는 한 entry를
공유하지 않는다. 같은 tick 안에서 key가 완전히 같은 호출만 in-flight promise와
결과를 재사용한다.

### 4. `listIssuesByStates()`는 full fetch와 로컬 필터를 유지한다

`listIssuesByStates(project, states)`의 원칙은 여전히 유효하다. 이 operation은
upstream spec §8.6의 startup terminal workspace cleanup처럼 요청받은 terminal
상태 자체를 찾아야 한다. candidate용 `-status:<terminal>` snapshot을 재사용하면
필요한 item이 이미 제외되어 correctness를 깨뜨린다.

이 경로는 workflow lifecycle을 normalization 입력으로 유지하되,
terminal-state server filter만 비활성화해 unfiltered snapshot을 조회한다. 그런
다음 요청받은 상태 이름을 trim 및 case-insensitive 비교로 로컬 필터링한다.
임의의 요청 상태를 긍정 query로 바꾸지 않는 이유는 다음과 같다.

- 존재하지 않거나 rename된 상태가 빈 결과로 성공하는 silent failure를
  피한다.
- adapter operation이 요청받은 임의 상태 집합을 정확하게 처리한다.
- startup cleanup의 보수적인 correctness가 candidate 조회 비용 최적화보다
  우선한다.

따라서 같은 tick의 `listIssues()`와 `listIssuesByStates()`가 항상 단일 fetch를
공유한다는 2026-03-19 ADR의 결과 설명은 폐기한다. candidate filtering이
활성화된 경우 두 operation은 의도적으로 filtered/unfiltered entry를 각각
사용한다.

## Consequences

### Positive

- Done 같은 terminal item이 누적되어도 candidate 조회 페이지 수가 전체 보드
  크기에 선형으로 증가하지 않는다.
- 부정 필터는 새 active/wait 상태를 기본적으로 포함하므로 상태 추가에
  fail-open한다.
- per-tick cache는 같은 query의 중복과 동시 fetch를 계속 제거한다.
- startup cleanup은 terminal item을 누락하지 않고 기존 의미를 유지한다.

### Negative

- 한 tick 안에서도 candidate와 arbitrary-state 조회에는 서로 다른 GraphQL
  fetch가 필요할 수 있다.
- GitHub의 query parser와 `status:` qualifier는 외부 API 계약이므로 schema 및
  실보드 동작을 회귀 검증해야 한다.
- 잘못된 부정 상태 이름은 비용 최적화를 약화시키지만 오류로 드러나지 않을
  수 있다. 로컬 lifecycle 판정은 안전성을 보존하지만 observability 확인이
  필요하다.

### Neutral

- `fetchIssueStatesByIds()`의 `nodes(ids:)` 기반 active-run reconciliation은
  project item candidate cache의 대상이 아니며 이 결정으로 바뀌지 않는다.
- 이 ADR은 #500의 runtime 동작과 #515의 explicit state lookup 보정을
  문서화한다. 새 configuration 변경을 요구하지 않는다.

## Validation

다음 계약을 TC로 유지한다.

1. `Status` lifecycle이면 terminal 상태를 quote한 부정 query를
   `ProjectV2.items(query:)`에 전달한다.
2. 사용자 정의 state field 또는 terminal 상태가 없으면 unfiltered fetch로
   fallback한다.
3. active/terminal 상태가 겹치면 GraphQL 호출 전에 실패한다.
4. 같은 query key는 per-tick cache를 공유하고, filtered/unfiltered lifecycle은
   cache key를 공유하지 않는다.
5. `listIssuesByStates()`는 server filter 없이 전체 snapshot에서 요청 상태를
   로컬 필터링한다.

이 계약은 `packages/tracker-github/src/tracker-github.test.ts`의 Project item
filtering 및 shared cache TC로 검증한다.

# ADR: GitHub Project V2 state filtering limitation과 per-tick cache

- **Date**: 2026-03-19
- **Status**: Accepted
- **Related Issues**: #59, #60, #61
- **Related Spec**: `docs/symphony-spec.md` Section 11.2

## Context

GitHub Project V2 GraphQL API는 project item 조회 시 상태 필드 기준의 query-time filtering을 제공하지 않는다.
따라서 orchestrator가 특정 workflow state만 필요하더라도 전체 project item을 가져온 뒤 코드에서 상태를 필터링해야 한다.

이 제약은 orchestrator 내부의 서로 다른 tracker 조회 경로에서 중복 fetch를 유발할 수 있다.

- startup cleanup이 terminal state issue를 찾기 위해 `listIssuesByStates()`를 호출
- 같은 poll tick의 candidate listing이 dispatch 후보를 찾기 위해 `listIssues()`를 호출

`#60` 이후 running issue reconciliation은 `nodes()` 기반 `fetchIssueStatesByIds()`를 사용하므로, 이 ADR의 cache 공유 대상은 full-project fetch가 필요한 `listIssues()` 계열 호출로 한정된다.

## Decision

다음 원칙을 채택한다.

1. `listIssuesByStates()`는 GitHub API에 state filter를 위임하지 않고, full-project fetch 결과를 로컬에서 필터링한다.
2. orchestrator는 poll tick 단위의 `projectItemsCache`를 생성하고 같은 tick 안의 tracker 호출에 공유한다.
3. cache 범위는 단일 tick으로 제한하여 다음 tick에서 stale project item snapshot이 재사용되지 않도록 한다.

## Consequences

- startup cleanup과 이후 loop tick은 서로 다른 cache 인스턴스를 사용하므로 cleanup side effect 이후에는 새 project snapshot을 다시 읽는다.
- 같은 loop tick 안에서 `listIssues()`와 `listIssuesByStates()`가 함께 호출되면 단일 full-project fetch 결과를 재사용한다.
- tick 경계가 바뀌면 cache도 폐기되어 최신 project 상태를 다시 읽는다.
- GitHub Project V2 API의 state filtering limitation은 구현 차이가 아니라 의도된 adapter 제약으로 문서화된다.

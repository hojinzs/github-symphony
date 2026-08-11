# docs/

문서 배치 규칙과 인덱스. 새 문서를 추가할 때 아래 분류에 따라 배치한다.

## 분류 규칙

| 위치             | 성격                                                       | 규칙                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/` 루트     | **살아있는 문서** — 현재 동작의 진실을 담고 계속 갱신됨    | 날짜 접두어 없음. 코드가 바뀌면 함께 갱신할 책임이 있음                                                                                                                           |
| `docs/adr/`      | **결정 기록** — 왜 이렇게 했는가                           | `YYYY-MM-DD_slug.md`. 결정 후 수정하지 않고, 뒤집을 땐 새 ADR로 supersede                                                                                                         |
| `docs/designs/`  | **구현 전 설계·플랜** — 무엇을 어떻게 만들 것인가 (시점성) | `YYYY-MM-DD-slug.md`. 헤더에 `Status`(Draft → Approved → Shipped/Abandoned)와 `Symphony Layers`(해당 레이어 나열)를 반드시 기재. 출하 후 Status만 갱신하고 본문은 히스토리로 보존 |
| `docs/reports/`  | **시점성 분석** — 감사, 타당성 조사, RCA                   | `YYYY-MM-DD-slug.md`. 작성 시점의 스냅샷. 본문을 최신화하지 않으며, 후속 조치가 있으면 헤더 상태 줄에만 링크                                                                      |
| `docs/examples/` | 사용자용 예시 파일                                         | 실제 동작과 일치하게 유지                                                                                                                                                         |

`Symphony Layers`는 `AGENTS.md`가 정의하는 6개 레이어 분류(Policy / Configuration / Coordination / Execution / Integration / Observability)를 따른다. 설계는 보통 여러 레이어에 걸치므로 디렉토리가 아니라 헤더 메타데이터로 태깅한다.

## 살아있는 문서

- [symphony-spec.md](symphony-spec.md) — 상류 Symphony 스펙 (Draft v1). **읽기 전용, 절대 수정 금지**
- [configuration.md](configuration.md) — 설정·환경변수 레퍼런스

단일 패키지에 국한된 아키텍처 문서는 해당 패키지의 `README.md`에 둔다 (예: [packages/control-plane/README.md](../packages/control-plane/README.md)).

## designs/

| 문서                                                                                                                         | 레이어                                                        | 상태              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| [2026-05-10-cli-restructure-design.md](designs/2026-05-10-cli-restructure-design.md)                                         | Coordination, Configuration                                   | Shipped           |
| [2026-05-10-cli-restructure-issues.md](designs/2026-05-10-cli-restructure-issues.md)                                         | Coordination, Configuration                                   | Completed (플랜)  |
| [2026-07-06-github-project-repo-dispatch-filter-design.md](designs/2026-07-06-github-project-repo-dispatch-filter-design.md) | Integration, Coordination, Observability                      | Shipped (PR #435) |
| [2026-08-11-standalone-project-model-design.md](designs/2026-08-11-standalone-project-model-design.md)                       | Policy, Configuration, Coordination, Execution, Observability | Draft             |
| [2026-08-11-agent-bootstrap-plugin-pm-steward-design.md](designs/2026-08-11-agent-bootstrap-plugin-pm-steward-design.md)     | Policy, Configuration, Coordination, Observability            | Draft             |
| [2026-08-11-standalone-project-model-issues.md](designs/2026-08-11-standalone-project-model-issues.md)                       | (플랜)                                                        | Active            |

## reports/

| 문서                                                                                                             | 상태                                        |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [2026-05-04-single-repo-orchestrator-feasibility.md](reports/2026-05-04-single-repo-orchestrator-feasibility.md) | Concluded — ADR로 승격                      |
| [2026-06-25-spec-gap-analysis.md](reports/2026-06-25-spec-gap-analysis.md)                                       | Retired — living map 유지 중단, 최종 스냅샷 |
| [2026-07-06-risk-audit-report.md](reports/2026-07-06-risk-audit-report.md)                                       | 검수 대기 (이슈 미발행)                     |
| [2026-07-19-github-api-rate-limit-audit.md](reports/2026-07-19-github-api-rate-limit-audit.md)                   | 부분 구현 (R1.5 출하)                       |

## adr/

ADR 목록은 [adr/](adr/) 디렉토리 참조. 최신 결정이 과거 결정을 대체하는 경우 헤더의 `Supersedes`로 연결된다.

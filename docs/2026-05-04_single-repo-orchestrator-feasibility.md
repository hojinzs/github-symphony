# Feasibility Study: Single-Repository Orchestrator Model

- **Date**: 2026-05-04
- **Author**: hojinzs@gmail.com (with Claude assist)
- **Status**: Investigation / pre-ADR
- **Related**:
  - upstream spec: `docs/symphony-spec.md` (Draft v1)
  - reference impl: <https://github.com/openai/symphony> (elixir)
  - PR #255 (Linear adapter ADR draft): `docs/adr/2026-04-29_linear-tracker-integration.md` (in PR)
  - existing ADR: `docs/adr/2026-03-16_issue-centric-state-model.md`
  - gap analysis: `docs/spec-gap-analysis.md`

> Per-assumption review by Codex (gpt-5-codex via `codex:codex-rescue`) is recorded inline. The Codex outputs are quoted verbatim and condensed; raw transcripts live in the agent task output store.

---

## 1. 배경 / 동기

upstream Symphony spec (`docs/symphony-spec.md` §3, §5) 은 명시적으로 **단일-리포 + repo-local `WORKFLOW.md`** 모델이다. OpenAI 의 Elixir 레퍼런스 구현 (<https://github.com/openai/symphony/blob/main/elixir/README.md>) 도 `./bin/symphony ./WORKFLOW.md` 한 명령으로 시작하고, `hooks.after_create` 안에서 `git clone` 하는 형태로 한 워크스페이스 = 한 리포를 가정한다.

그러나 현재 github-symphony 구현은 GitHub Project V2 가 _여러 linked repository_ 를 가질 수 있다는 사실을 1급으로 받아들여 multi-tenant 형태로 발전했다 (`docs/spec-gap-analysis.md` D4 — `<root>/<projectId>/issues/<key>/repository` 디렉터리, `OrchestratorProjectConfig.repositories: RepositoryRef[]` 배열). 그 결과:

1. **PR #255 와의 충돌** — Linear 어댑터는 "이슈에 repo 가 없다 → config 에서 단일 repo 를 주입한다" 는 단일-repo 매핑을 1차 범위로 권장. GitHub 쪽은 array, Linear 쪽은 single 으로 양식이 갈라진다.
2. **upstream spec 부합 약화** — `docs/symphony-spec.md` §5.1 은 "the workflow file is expected to be repository-owned"; 현재는 `loadProjectWorkflow` 가 `tenant.repositories[0]` 또는 `issue.repository` 의 WORKFLOW.md 를 로드하는 정책 의존 동작이 됐다 (`packages/orchestrator/src/service.ts:1100-1140`).
3. **부트스트랩 복잡도** — 사용자가 GitHub Project ID, projectSlug, projectConfig 디렉터리를 거쳐야 시작할 수 있다. 한편 spec/레퍼런스는 `cd repo && gh-symphony start` 의 단일 동작이다.

---

## 2. 제안하는 단일-리포 모델

```
$ git clone git@github.com:acme/platform.git
$ cd platform
$ gh-symphony repo init     # WORKFLOW.md 가 없으면 생성, 있으면 인식. tracker auth 검증.
$ gh-symphony repo start    # 폴링 시작, 이 리포의 WORKFLOW.md 를 정책으로.
```

핵심 변경:
- `OrchestratorProjectConfig.repositories: RepositoryRef[]` → `repository: RepositoryRef` 단일 필드.
- `WORKFLOW.md` 의 1차 출처는 **cwd (또는 명시된 리포 디렉터리)**. 사용자가 `--workflow-file <path>` 로 override 하면 그 경로가 우선 (이미 spec §5.1).
- 디렉터리 레이아웃: `.runtime/orchestrator/<workspaceKey>/...` (또는 `.runtime/orchestrator/issues/<workspaceKey>/...`) — `<projectId>` 단계 제거.
- CLI: `init`/`start`/`status`/`stop` 가 cwd 기반. `--project-id` 는 사라지거나 internal-only.
- tracker config: `tracker.settings.repository = "owner/repo"` 가 GitHub/Linear 양쪽 공통 모양.

이 모델은 spec §3.1, §5.1 에 정확히 들어맞으며, 한 머신에서 여러 리포를 운영하고 싶다면 **"리포당 한 서비스 인스턴스"** 패턴으로 외부에서 multiplex 한다. (= unix way; Linear 하나만 운영하면 그것도 한 인스턴스.)

---

## 3. 가정별 평가 + Codex 리뷰

### A1 — 구현 가능성

> 가정: 멀티-리포 가정은 표면적이며, `repositories: RepositoryRef[]` → `repository: RepositoryRef` 평탄화 시 의미 손실이 거의 없다.

**나의 분석**: issue/run/workflow 처리 경로는 사실상 모두 단일 repo 를 가정하고 동작 중이다 (`run.repository` 는 항상 단일, `loadProjectWorkflow` 는 첫 리포 또는 `issue.repository` 사용).

**Codex 리뷰 결과 (verdict: 부분적으로 맞음)**:

> "issue/run/workflow 자체는 단일 repo 중심이지만, project-wide 정책(poll interval, concurrency)은 `tenant.repositories` 배열 전체를 집계(min/merge)한다."
>
> Hidden coupling:
> - `packages/orchestrator/src/service.ts:2527` — poll interval 을 repos 전체에서 min 으로 집계
> - `packages/orchestrator/src/service.ts:2546` — concurrency 정책을 여러 repo 에서 merge/min
> - `packages/orchestrator/src/service.ts:825` — startup terminal cleanup 이 resolved repos 전체 순회
>
> Confidence: medium.

**해석**: 평탄화는 의미적으로 가능하지만, 정책 집계 로직 ~3곳이 array 전제 위에 깔려 있다. 단일 리포로 가면 이 집계 함수들이 **단순화** (min(x) → x). 즉 array 제거가 오히려 코드를 줄이는 방향이지, 새 기능 손실은 없다. 단일-issue-repository 계약은 이미 안정.

---

### A2 — 노력 규모

> 가정: 코어 변경 + 테스트 fixture + 마이그레이션 1회 = **30~50시간 (3~7일)** / 1인.

**나의 분석**: 핵심 파일 ~10~15개. service.ts (3,381 LoC) 에서 `tenant.repositories` 참조 ~10곳. service.test.ts (2,753 LoC) 의 fixture 갱신이 최대 비용.

**Codex 리뷰 결과 (verdict: 낙관적)**:

> "프로덕션 코드 델타(`status-surface.ts:15-21`, `fs-store.ts:43-188,297-346`, `service.ts:868-946,2527-2638`)는 **700~1,100 LoC** 추정치이며, `service.test.ts`의 **64개/94개 테스트가 `tenant-1`/project path를 내장**해 30~50h는 빡빡함."
>
> Bigger-than-expected surface:
> - `packages/core/src/contracts/state-store.ts:11-40` — store API 가 `projectId` 필수 파라미터로 고정
> - `packages/core/src/workspace/identity.ts:12-14,43-60` — workspace path/key 에 `projectId` 내장
> - `packages/dashboard/src/store.ts:33-47` — control-plane `/api/v1/state` 서버 경로 의존이 예상보다 깊음 (client 는 얕지만 server store 는 아님)
>
> Hidden test debt: `e2e/seed/config.json:1-11` 은 단일 repo + `e2e-project` 하드코드라 e2e 부담 작으나, `service.test.ts` fixture 체인 규모가 숨겨진 부채.
>
> **Better effort estimate: 55~80h.** Confidence: medium-high.

**해석**: 추정 상향. 60~80h (1.5~2주) 가 더 현실적. 이유: state-store contract 와 identity util 의 `projectId` 내재화 + service.test.ts fixture chain.

---

### A3 — 아키텍처 단순화

> 가정: 단일-리포 전환은 (i) 키 체계 압축, (ii) control-plane `projectId` 라우팅 제거, (iii) issue-centric ADR (`2026-03-16`) 과 시너지 → 유의미한 유지보수성 향상.

**나의 분석**: 키 체계가 (projectId × repositoryId × workspaceKey) → (workspaceKey) 로 평탄화. control-plane 의 `projectId` 인자 (`docs/CONTROL_PLANE.md` §1.4 의 `ControlPlaneServerOptions.projectId`) 가 사라짐. spec divergence (D1~D6) 중 D4 가 해소되고 spec §3.1 layer 분리가 명료해진다.

**Codex 리뷰 결과 (gain: medium, synergy: 있음)**:

> "**Simplification gain: Medium** — `projectId` is pervasive but mostly namespace/routing glue; the harder repo/tracker/run logic stays regardless.
>
> Lost capabilities:
> - Multi-repo project configs via `repositories: RepositoryRef[]` (one orchestrator spanning N repos is gone)
> - Runtime root partitioning across multiple `projects/<projectId>` directories (one service per repo becomes the model)
>
> **Synergy with issue-centric ADR: Synergy** — ADR already moves state toward issue keys/workspaces; flattening removes the remaining project namespace layer.
>
> **Risk of premature collapse: Medium** — current CLI/tests explicitly support multi-repo; reintroducing it later would be real feature work, partly mitigated by the one-service-per-repo pattern.
>
> Confidence: Medium."

**해석**: 단순화 이득은 분명하나 "high" 가 아닌 "medium" — 어려운 로직(repo/tracker/run) 자체는 그대로다. 잃는 기능 2가지는 현실적 비용으로 인정해야 함:
- 한 오케스트레이터 인스턴스가 N 리포를 도는 시나리오 → 리포당 인스턴스로 다중화.
- 단일 `.runtime/` 아래 `<projectId>` 칸막이 → 인스턴스별 `--runtime-root` 로 분리.

다중 리포 관리가 정말 필요한 사용자에게는 "외부 multiplex" 가 답이 된다 (도커/systemd 단위로 인스턴스 띄우기). 이는 unix-style 이며 spec/레퍼런스 정신에도 맞는다.

---

### A4 — PR #255 와의 호환성

> 가정: 단일-리포 전환은 PR #255 의 단일 repo 매핑 권장과 맞물려, GitHub/Linear 어댑터가 같은 contract 를 공유한다. 비용은 줄거나 같다.

**나의 분석**: PR #255 ADR 은 "Linear 이슈에 repo 개념이 없다 → `tracker.settings.repository = \"owner/repo\"`" 를 1차 범위로 명시. GitHub 가 array 를 유지하면 두 어댑터 양식이 갈라진다. 통일하면 어댑터별 분기가 사라진다.

**Codex 리뷰 결과 (verdict: 부분적으로 맞음)**:

> "읽은 타입 기준으로 `TrackedIssue.repository` / `OrchestratorRunRecord.repository`는 이미 단일 `RepositoryRef`지만 `OrchestratorProjectConfig.repositories`는 배열이라, issue/run 출력 계층의 flattening 만 공통 계약과 맞습니다.
>
> **Contract unification benefit:**
> - 단일 `issue.repository`로 오케스트레이터가 어댑터별 분기 없이 워크스페이스/런 환경을 만들 수 있음
> - `reviveIssue(project, run)` 도 `run.repository` 로 동일한 `TrackedIssue` 형태를 복원
>
> **Phase 3 risk** (label-based multi-repo routing): label 기반 routing 은 `TrackedIssue` 생성 _전에_ 단일 `RepositoryRef` 를 선택해야 하므로, 단일 issue repository 계약 자체를 되돌리지는 않음.
>
> **Recommendation for PR #255:** 머지와 단일-리포 GitHub 전환은 independent. 단, PR 이 core config 를 단일 repo 로 바꾸려 한다면 별도 검토.
>
> Confidence: medium."

**해석**: 두 작업은 직교적으로 진행 가능. Phase 3 라벨 라우팅은 트래커 어댑터 _내부_ 의 라우팅 로직이지 orchestrator core 의 repo 차원이 아니므로, 단일-issue-repository 계약을 깨지 않는다. PR #255 가 정식 ADR 로 굳어지기 전에 단일-리포 전환이 들어가면 PR #255 가 약간 더 단순해지는 정도지, 의존성은 없다.

---

## 4. 핵심 변경 표면 (codex 보강 반영)

| 영역 | 파일 | 변경 |
|---|---|---|
| Contract | `packages/core/src/contracts/status-surface.ts:15-21` | `repositories: RepositoryRef[]` → `repository: RepositoryRef` |
| Contract | `packages/core/src/contracts/state-store.ts:11-40` | store API 의 `projectId` 파라미터 제거 또는 옵션화 |
| Identity | `packages/core/src/workspace/identity.ts:12-14,43-60` | workspace path/key 에서 `projectId` 제거. ADR `2026-03-16` 의 `deriveWorkspaceKey(identifier)` 와 통합. |
| Orchestrator | `packages/orchestrator/src/service.ts:825,868-946,2527-2638` | array 집계(min/merge) → 직접 사용. tenant 모델 단순화. |
| Orchestrator | `packages/orchestrator/src/fs-store.ts:43-188,297-346` | 디스크 레이아웃 `.runtime/orchestrator/<workspaceKey>/...`. |
| Orchestrator | `packages/orchestrator/src/git.ts:116-134` | 변경 없음 (이미 단일 repo). |
| Tracker | `packages/tracker-github/src/orchestrator-adapter.ts` | `tracker.settings.repository = "owner/repo"` 모양으로 통일. |
| CLI | `packages/cli/src/commands/{init,start,project,repo}.ts` | cwd 기반 동작. `--project-id` 옵션 제거 또는 hidden. |
| Control plane | `packages/control-plane/src/server.ts`, `packages/dashboard/src/store.ts:33-47` | `projectId` 라우팅 제거. |
| Tests | `packages/orchestrator/src/service.test.ts` (94 suites, 64 tests 영향), e2e fixtures | fixture 체인 갱신. |

추가로 ADR 문서 + spec gap 분석 갱신 + 마이그레이션 스크립트.

---

## 5. 마이그레이션 / 기존 데이터

기존 사용자는 `.runtime/orchestrator/projects/<projectId>/...` 디렉터리를 갖고 있다. 두 가지 옵션:

1. **자동 마이그레이션 스크립트** — `gh-symphony repo init` 시 단일 `<projectId>/` 가 발견되면 그 내용을 `.runtime/orchestrator/` 루트로 promote, run records 의 `projectId` 필드 유지 (호환성용). 다중 `<projectId>/` 가 발견되면 사용자에게 명시적 선택 (또는 인스턴스 분리 안내).
2. **Breaking change + 새 출발** — runtime 디렉터리를 새로 만들고 기존 거는 read-only archive 로 남김.

추천: (1). spec divergence 가 줄어드는 PR 인 만큼 사용자 마찰을 최소화.

---

## 6. 리스크

- **Premature collapse risk: medium** (codex). 한 인스턴스가 N 리포를 도는 시나리오는 현재 코드/테스트가 명시적으로 지원함. 미래에 진짜 다중-리포가 다시 필요해지면 "리포당 인스턴스" 우회로는 어색해질 수 있다. 다만 이는 대부분의 single-tenant 도구가 같은 답을 갖는 표준 트레이드오프.
- **테스트 부채 (codex A2)**: `service.test.ts` 의 fixture chain. 견적 상향 (60~80h) 의 주요 원인.
- **Control-plane 서버 store 의존 (codex A2)**: `packages/dashboard/src/store.ts` 의 server 측 `projectId` 의존이 client 보다 깊다. UI 일부가 동시 영향.
- **PR #255 와의 합의** — 본 전환을 PR #255 머지 전에 결정하면 PR #255 ADR 텍스트가 더 단순해진다 (Linear/GitHub 같은 모양). 머지 후라도 병행 가능.

---

## 7. 결론 / 권장

| 질문 | 답 |
|---|---|
| 현재 구현에서 변경 가능한가? | **예** — 표면 변경. 정책 집계 로직(min/merge) 이 단순화되는 방향. |
| 변경에 드는 노력은? | **60~80h (1.5~2주) / 1인** — codex 상향. |
| 아키텍처가 단순해지는가? | **medium 단순화** — 키 체계 압축 + control-plane 라우팅 제거 + ADR 시너지. 단, 어려운 로직 자체는 유지. |

**권장 다음 단계**:

1. 본 문서를 ADR 로 승격 (`docs/adr/2026-05-04_single-repo-orchestrator.md`) 후 의사결정 게이트.
2. 의사결정이 "go" 면 다음 순서로 분할:
   - (P1) contract 변경 + identity util 통합 + ADR `2026-03-16` 의 `deriveWorkspaceKey` 채택
   - (P2) service.ts 정책 집계 로직 단순화 + fs-store 레이아웃 변경
   - (P3) CLI cwd 기반 흐름 + 마이그레이션 스크립트
   - (P4) control-plane / dashboard 서버 측 `projectId` 제거
   - (P5) 테스트 fixture 일괄 갱신 + e2e 검증
3. PR #255 와는 직교 진행 — 단, 본 전환이 먼저 들어가면 PR #255 ADR 의 GitHub/Linear contract 통일 표현이 더 자연스러워진다.

---

## 부록 — Codex 리뷰 메타

- 4건 모두 `codex:codex-rescue` (gpt-5-codex) 로 독립 2차 의견 요청.
- A3 는 1차 시도 stall → 짧은 프롬프트로 재시도 후 응답 수령.
- 모든 verdict 가 "high confidence" 가 아닌 "medium" — 즉 본 문서는 **방향성 합의용**이며, 실제 구현 진입 전 ADR 단계에서 한 번 더 codex/리뷰어 합의를 받는 것을 권장.

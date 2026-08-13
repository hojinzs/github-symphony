# Spec: Standalone 프로젝트 모델 — 리포 비종속 실행 단위와 수퍼바이저 토폴로지

- **Date**: 2026-08-11
- **Status**: Shipped
- **Symphony Layers**: Policy (WORKFLOW.md 외부화), Configuration (프로젝트 매니페스트·MCP·스킬 레이어), Coordination (수퍼바이저 토폴로지, 등록 검증), Execution (worktree populate, 스킬/MCP 주입), Observability (상태 집계, 그림자 경고)
- **Related ADRs**:
  - `docs/adr/2026-05-04_single-repo-orchestrator.md` — "1 repo = 1 instance" 채택. 본 설계는 이를 **"1 project = 1 instance"로 정밀화**한다(리포 1 : 프로젝트 N 허용). 확정 시 후속 ADR로 관계를 명시할 것.

## Context / Problem

현재 방식은 리포지토리 안에 WORKFLOW.md와 스킬을 커밋하는 repo-embedded 모델이다. 다섯 가지 문제가 있다:

| #   | 문제                                                                     |
| --- | ------------------------------------------------------------------------ |
| P1  | 리포를 받은 사람에게 에이전트 워크플로우가 강제됨                        |
| P2  | 한 리포에 여러 프로젝트(기능 트랙)를 병행 오케스트레이션할 수 없음       |
| P3  | 로컬 체크아웃의 수정사항이 실행에 영향을 줌                              |
| P4  | 이슈 시작 시 스캐폴딩(worktree 위치, env, 시작 스크립트) 커스텀이 어려움 |
| P5  | WORKFLOW.md/스킬 세팅이 리포 커밋을 요구해 온보딩이 번거로움             |

공통 원인: **오케스트레이션 정책(Policy 레이어)의 저장 위치가 소스 리포지토리에 결합**되어 있다.

## Goals

1. **이중 모드** — 기존 repo-embedded 모드 유지 + 리포 밖 프로젝트 폴더 기반 **standalone 모드** 추가
2. **Repo-unaware 원칙** — standalone 모드에서 리포지토리는 Symphony가 돈다는 사실을 모른다 (커밋 흔적·필수 파일 없음)
3. **Control Plane 준비** — 프로젝트 폴더 구조가 곧 향후 Control Plane의 데이터 모델이 된다

향후 Control Plane 요구(설계 제약으로만 참조): 리포 연결·프로젝트 생성(CP1), WORKFLOW.md 에이전트 자동 생성(CP2), 트래커 이슈 발행 에이전트(CP3), 실행 로그 조회(CP4).

## Decisions

### D1. 프로젝트 매니페스트 = WORKFLOW.md front matter (별도 매니페스트 없음)

업스트림 스펙이 이미 정의한다: front matter(`tracker`/`polling`/`workspace`/`hooks`/`agent`/`codex`)가 매니페스트이고, §5.2 설계 노트가 "out-of-band 설정 없는 자체 완결"을 요구한다. 별도 `project.yaml`은 만들지 않는다.

- 리포 참조는 §5.3 확장 규칙에 따라 **`repository` 확장 키**로 추가한다.
- 외부 WORKFLOW.md는 divergence가 아니다 — §5.1 경로 우선순위 1번("explicit runtime setting")이 그 자체다. 유일한 마찰인 "repository-owned and version-controlled" soft expectation만 문서화한다.
- 제안하신 `.runners/` 구조도 새 메커니즘이 아니라 프로젝트별 front matter의 `workspace.root` 지정으로 구현된다 (per-issue 경로 규칙 `<root>/<sanitized_issue_id>`는 §9.1 그대로).

### D2. 프로젝트 = 일급 실행 단위, 기존 `OrchestratorProjectConfig` 확장

"프로젝트"는 WORKFLOW.md 정책 + 트래커 매핑 + 스킬/MCP 레이어 + worktree 풀을 묶은 **오케스트레이션 실행 단위**다. 리포지토리는 프로젝트가 참조하는 자원일 뿐이다 (리포 1 : 프로젝트 N).

- 새 개념을 만들지 않고 기존 `OrchestratorProjectConfig`(`packages/core/src/contracts/status-surface.ts`)를 확장한다. 이미 `projectId`/`slug`/`workspaceDir`/`repository`/`tracker`를 갖고 있고, 상태 저장소·status surface가 이 위에 있어 마이그레이션이 최소화된다.
- 추가 필드: `workflowSource: { type: "repo" } | { type: "external"; path }` 등.
- **프로젝트 폴더가 진실 소스, `config.json`은 등록/파생 상태**로 규정한다.
- 상태 디렉토리 `workspaces/` 네이밍은 스펙 Workspace(§4.1.4, per-issue 디렉토리)와 충돌 — 별도 정리 항목.

### D3. 워크플로우 소스는 우선순위 경쟁이 아니라 모드 선언

프로젝트가 `workflow source`를 선언한다: standalone 프로젝트는 외부 파일만 읽고 리포 내부는 조회하지 않는다. repo-embedded는 그 반대. "양쪽을 탐색해 승자를 정하는" 동적 규칙은 두지 않는다.

- 근거 1 — 보안: `hooks.*`는 호스트에서 셸을 실행한다. 리포 내부가 이기는 규칙이면 리포 커밋 권한자가 운영자 머신에서 임의 셸을 실행할 수 있다. 실행 정책의 통제권은 운영자에게 남긴다.
- 근거 2 — §5.1의 "explicit runtime setting > cwd default"와 동일한 구조.
- 그림자 상황(standalone 모드인데 리포에도 WORKFLOW.md 존재)은 status surface에 경고로 노출한다.

### D4. 전역 bare 클론 캐시 + 빌트인 worktree populate

- 리포 클론은 전역 캐시(`~/.gh-symphony/repos/<owner>/<repo>.git`)에 bare로 한 번만 둔다. 리포 1 : 프로젝트 N 구조와 정합. Symphony 홈은 새로 만들지 않고 기존 CLI 설정 디렉토리 `~/.gh-symphony`(`DEFAULT_CONFIG_DIR`)를 그대로 쓴다.
- 이슈 workspace populate(클론 캐시에서 worktree 생성)는 `after_create` 훅 관례가 아니라 **빌트인 기능**으로 구현한다 (`repository` 확장 키 기반). 스펙 §9.3이 populate를 implementation-defined로 명시하므로 conforming.
- 격리된 worktree 실행으로 P3(로컬 수정사항 영향) 해결.
- 운영 상세(잠금·fetch 정책·수명주기)는 아래 "클론 캐시 운영 상세" 섹션 참조.

### D8. 브랜치 네임스페이스 — 프로젝트 슬러그 포함 필수

기본 브랜치 템플릿을 **`symphony/<project-slug>/<sanitized-issue-id>`**로 하고, front matter로 템플릿 오버라이드를 허용한다.

이것은 스타일 선택이 아니라 D4의 구조적 귀결이다: git은 같은 브랜치를 두 worktree가 동시에 체크아웃하는 것을 거부하므로, bare를 프로젝트끼리 공유하는 순간 같은 리포 위 모든 프로젝트·이슈의 브랜치 유일성이 git 레벨에서 요구된다. 원격 push 충돌 방지까지 겸해, project-slug를 브랜치명에 포함해 유일성을 구조적으로 보장한다.

### D5. 스킬 주입 — 프로젝트 생성 시 렌더링, attempt마다 병합 복사, git에서 은폐

> 프로젝트 생성 시 렌더링 → 매 attempt 전(before_run 지점) 전역+프로젝트 레이어 병합 복사 → worktree의 런타임 네이티브 경로(`.claude/skills` / `.codex/skills`)에 배치 → worktree별 `.git/info/exclude`로 git에서 은폐.

- **복사, 링크 금지**: 심볼릭 링크는 워커가 공유 스킬 디렉토리를 변조해 전 프로젝트에 전파시킬 수 있고(cross-issue 오염 사고 클래스), 샌드박스 경계(codex `turn_sandbox_policy`)를 탈출하며, 실행 당시 스킬 스냅샷 관측이 불가하다. 복사 비용은 KB 단위로 무시 가능.
- **매 attempt 재복사**: 스펙 §9.1의 workspace 재사용 때문에 `after_create` 단발 주입은 스킬 수정이 후속 run에 반영되지 않는다. 재복사가 링크의 유일한 장점(신선도)을 흡수한다.
- **`.git/info/exclude` 등록**: 스킬이 `git status`에 잡혀 에이전트가 커밋하면 repo-unaware가 깨진다. per-worktree 설정이라 리포에 흔적이 없고, populate가 빌트인(D4)이므로 등록 지점도 자연스럽다.
- **레이어 병합**: 전역(`~/.gh-symphony/skills`) → 프로젝트(`<project>/.agent/skills`), 이름 충돌 시 프로젝트 승리(nearest wins).
- **생성형 스킬**(commit/push/land/gh-project 등 템플릿, `packages/cli/src/skills/`): 주입 시점이 아니라 **프로젝트 생성/수정 시점**에 프로젝트 스킬 레이어로 렌더링한다 (CP2와 같은 단계). 주입 로직은 "병합해서 복사"로 단순하게 유지.

### D6. MCP — 프로젝트 폴더의 `.mcp.json` 사이드카

업스트림 스펙에 MCP는 없다(전체 0건). 도구는 §10.5 어댑터 방식만 정의하므로 MCP 지원은 통째로 우리 확장 영역이고, front matter 확장 키 제약을 받을 이유가 없다.

- **선언**: 프로젝트 폴더 루트의 `.mcp.json` (표준 `mcpServers` shape). 근거: (1) standalone의 자기완결 단위는 파일이 아니라 프로젝트 폴더이며 `.agent/skills/`로 이미 선례가 있다. (2) 사실상 표준 포맷 — 기존 리포의 `.mcp.json`을 폴더로 복사하면 그대로 동작(마이그레이션 공짜), 스키마 검증기·에디터 지원 재사용, Control Plane 편집 UI 단순화. (3) YAML front matter에 중첩 JSON을 넣는 어색함 회피. (4) 역할 분리: WORKFLOW.md = 정책+오케스트레이션 설정, `.mcp.json` = 에이전트 도구 설정.
- **레이어 우선순위**: Symphony 내장(예약 이름 `github_graphql`/`linear_graphql`, 항상 승리) > 프로젝트 `.mcp.json` > 전역 `~/.gh-symphony/mcp.json` > 리포 `.mcp.json`. 내장 도구가 그림자당하면 워크플로우 전이가 깨지므로 예약 이름으로 보호.
- **리포 레이어는 standalone에서 기본 off, 명시 opt-in** (`trust_repo_config` 류). MCP 엔트리는 호스트에서 실행할 명령이므로 D3과 동일한 보안 논리.
- **시크릿**: 리터럴 토큰 금지, §6.1 `$VAR` 간접 참조만 허용 (검증으로 강제). tracker 토큰은 기존 broker 경유 유지 — 업스트림 §10.5 "MUST NOT require the coding-agent child process to read raw tracker tokens" 원칙.
- **합성**: 기존 `mcp-compose.ts` 패턴 재사용 — 매 attempt, worktree 밖 runtime 디렉토리에 0600으로 합성. attempt 단위 합성이므로 사이드카 watch 불필요 (동적 리로드는 오케스트레이터 루프용 front matter만 해당).
- **런타임 비대칭**: 선언은 core에 런타임 중립 shape로 한 번, 번역은 어댑터 책임 — claude는 합성 `.mcp.json` + `--mcp-config` argv, codex는 `RuntimeToolDefinition` 등록(`packages/runtime-codex/src/runtime.ts`).

### D7. 토폴로지 — 오케스트레이터 불변, 수퍼바이저 상위 배치

**오케스트레이터는 현재 그대로 둔다: 프로세스 = 프로젝트 1개** (`OrchestratorService` 생성자가 단일 `projectConfig`를 받는 현 구조 유지). 멀티 프로젝트는 상위의 **수퍼바이저**가 담당한다.

- 근거: 스펙 §2.2 Non-Goals가 "Rich web UI or multi-tenant control plane"을 명시 — 멀티 테넌시를 오케스트레이터 안에 넣는 것은 스펙의 범위 선언을 거스른다. 스펙 전체가 오케스트레이터를 단일 워크플로우 standalone 서비스·단일 상태 권위자로 취급하고(§7, §8.1, Appendix A), 멀티 인스턴스 토폴로지는 의도적으로 구현자 몫이다. 따라서 수퍼바이저는 divergence가 아니라 **스펙 밖 확장 레이어**다.
- 수퍼바이저 책임: 프로젝트 폴더 등록·발견, 프로젝트당 오케스트레이터 프로세스 스폰·재시작·헬스체크, 자식 상태 서버 포트 배정(또는 unix socket), 상태 API 집계 후 단일 엔드포인트(:4680) 노출. **Control Plane은 수퍼바이저만 상대한다.**
- **등록 시점 서로소 검증**: 같은 리포+트래커를 공유하는 프로젝트들의 트래커 매핑(project_slug, 라벨, 상태 보드)이 겹치지 않음을 수퍼바이저가 프로젝트 등록 시 검증한다. 오케스트레이터끼리 서로 모르므로 런타임 조율이 아닌 등록 시 검증이 맞는 자리다.
- 레이트리밋: 인스턴스별 독립 폴링이지만 기존 자가 스로틀링(낮은 rate limit 감지 시 폴링 간격 확대)이 폭주를 막는다. 교차 조율이 필요해지면 수퍼바이저에 후속 추가.

### D9. 프로젝트 env는 `<project>/.env` 파일 — front matter `env` 키 없음

프로젝트 env는 프로젝트 폴더의 `.env`(dotenv 포맷, 0600 강제)로 선언한다. front matter `env` 키는 만들지 않는다.

- **근거**: env 값은 대부분 시크릿이다. WORKFLOW.md는 repo-embedded 모드에서 리포에 커밋되고 Control Plane이 읽는 파일이므로, D6("선언 파일에 리터럴 토큰 금지")과 같은 논리로 시크릿의 자리는 선언 파일이 아니라 `.env`다. 메커니즘도 이미 존재한다 — `readProjectEnv`(`packages/orchestrator/src/service.ts`)가 프로젝트 디렉토리 `.env`를 워커 env에 병합 중이며, 작업은 읽는 위치를 프로젝트 폴더로 재지정하는 것뿐이다.
- **`.env`의 세 가지 역할**: (1) 훅 실행 env — P4의 시작 스크립트는 hooks, 변수는 `.env`로 P4 완결. (2) 워커 프로세스 env — 현행 유지. (3) front matter·`.mcp.json`의 **`$VAR` 해석 소스** — 해석 소스는 "호스트 process env + 프로젝트 `.env`". 스펙 §6.1은 env 간접 참조의 출처를 못박지 않으므로 clarification 수준.
- **에이전트 자동 전달 금지**: 프로젝트 env는 훅·워커·`$VAR` 해석까지만 간다. 에이전트 서브프로세스는 기존 `SAFE_RUNTIME_ENV_KEYS` allowlist(runtime-codex, PR #509 이력 참조)를 유지한다. 에이전트 내부에서 변수가 필요한 경우는 hooks가 담당하고, 명시적 passthrough 목록은 필요해질 때 추가한다 (YAGNI).
- **우선순위 현행 유지**: 명시 env > 호스트 process env > 프로젝트 `.env` (`buildProjectExecutionEnv` 스프레드 순서 그대로). 운영자의 호스트 env가 프로젝트 설정을 오버라이드하는 방향으로, D3의 "운영자 우선" 원칙과 일치.

## 클론 캐시 운영 상세 (D4·D8)

현재 구현은 이슈 워크스페이스마다 풀 클론이다 (`packages/orchestrator/src/git.ts` `syncRepositoryForRun` — `<workspace>/repository`에 clone, 실패 시 재클론). 본 설계는 이를 공유 bare 캐시 + worktree로 대체한다.

### 레이아웃과 잠금

```
~/.gh-symphony/repos/<owner>/<repo>.git    # bare 클론 (전 프로젝트 공유)
~/.gh-symphony/repos/<owner>/<repo>.lock   # mkdir 기반 락 디렉토리
```

- 토폴로지(D7)상 같은 리포를 공유하는 프로젝트들은 **서로 다른 프로세스**이므로, 캐시 조율 수단은 파일 락뿐이다.
- 기존 `git.ts`의 mkdir 락 패턴과 상수를 재사용한다 (재시도 100ms, stale 30분, 타임아웃 2분).
- 락 아래에서 직렬화하는 작업: bare 최초 생성(`clone --bare`), fetch, `worktree add`/`remove`/`prune`.

### Fetch 신선도 정책

- **populate(worktree 생성) 직전 fetch** — base ref 신선도는 populate의 책임.
- **TTL 스킵**: 마지막 fetch가 TTL 이내면 생략. bare 안의 타임스탬프 마커로 락 아래에서 판정. **기본값 60초.** 한 틱에 같은 리포의 이슈 여러 개가 디스패치될 때 fetch 연발을 막는다. 단, **필요한 ref가 없으면 TTL을 무시하고 fetch**한다.
- **재시도 attempt는 재fetch하지 않는다**: worktree는 이슈당 재사용되고(스펙 §9.1), 최신화(rebase 등)는 에이전트/워크플로우 정책의 몫이다.

### Worktree 수명주기

- **생성**: bare 확보 → TTL fetch → `git worktree add -b symphony/<project-slug>/<issue-id> <workspace-path> origin/<base>` (브랜치 템플릿은 D8).
- **실패 시맨틱**: 스펙 §9.3 그대로 — populate 실패는 해당 attempt 에러. 신규 워크스페이스면 부분 생성물 제거 가능, 재사용 워크스페이스는 파괴적 리셋 금지.
- **정리**: 스펙 §8.6(startup terminal workspace cleanup) 지점에 연결 — `before_remove` 훅 → `git worktree remove` → 락 아래 `git worktree prune`.
- **고아 GC**: populate 때마다 락 아래에서 `git worktree prune` 1회 (수동 삭제된 워크스페이스의 잔여 admin 데이터 정리, 비용 미미). 별도 GC 프로세스는 두지 않는다.
- **디스크**: fetch 후 `git gc --auto` 수준으로 시작. 정교한 사이즈 정책은 필요해지면 후속.

### 인증

현행 유지: bare fetch는 오케스트레이터 호스트 프로세스가 기존 credential 경로(gh auth / credential helper)로 수행한다. 토큰은 worktree에 기록하지 않는다.

### 적용 범위 (롤아웃)

populate 전략을 프로젝트 속성으로 둔다: `worktree-cache`(신규) vs `clone`(기존 풀클론). **standalone 프로젝트는 `worktree-cache`가 기본, repo-embedded는 당분간 기존 동작 유지** 후 수렴한다. 두 모드를 동시에 바꾸지 않는다.

## 목표 디렉토리 구조

```
~/.gh-symphony/                     # Symphony 홈 = 기존 CLI 설정 디렉토리 (DEFAULT_CONFIG_DIR)
  repos/<owner>/<repo>.git          # D4: 전역 bare 클론 캐시 (+ <repo>.lock)
  skills/                           # D5: 전역 스킬 레이어
  mcp.json                          # D6: 전역 MCP 레이어

projects/
  project-a/
    WORKFLOW.md                     # D1: 정책 + front matter 매니페스트 (repository 확장 키, workspace.root)
    .mcp.json                       # D6: 프로젝트 MCP ($VAR만)
    .agent/skills/                  # D5: 프로젝트 스킬 레이어 (생성형 스킬 렌더링 위치)
    .env                            # D9: 프로젝트 env (dotenv, 0600) — 훅·워커·$VAR 해석 소스
  project-b-1/                      # 같은 리포의 두 번째 프로젝트 (P2 해결)
    WORKFLOW.md
    ...

<workspace.root>/                   # 프로젝트별 front matter가 지정 (.runners 등 자유)
  <sanitized-issue-id>/             # per-issue workspace = 클론 캐시에서 딴 worktree
                                    # 스킬/MCP는 attempt마다 주입, .git/info/exclude로 은폐
```

## Open Questions (후속 결정)

1. **수퍼바이저 상세 설계** — **별도 설계 문서로 분리** (본 스펙 범위 아님). 프로세스 수명주기, 상태 집계 API shape, 등록 프로토콜. 참고: CLI에 프로토-수퍼바이저 인프라가 이미 존재 — `~/.gh-symphony/projects/<id>/project.json` 레지스트리, 프로젝트별 데몬 PID·로그·liveness 판정(`packages/cli/src/daemon-liveness.ts`), `@gh-symphony/control-plane`·`@gh-symphony/dashboard` 패키지. 별도 설계는 이 위에서 시작할 것.
2. **`workspaces/` 상태 디렉토리 네이밍 정리** — 스펙 Workspace와 용어 충돌 (D2)
3. **codex 런타임 스킬 발견 경로 검증** — cwd 기준인지 확인 후 D5 배치 확정 (`runtime-codex`에서 검증)
4. **Control Plane 시크릿 저장소** — `$VAR`의 원천을 프로젝트별로 관리하는 방법 (Control Plane 설계 시). D9의 `.env`가 당분간의 저장소이며, Control Plane은 이를 대체가 아닌 관리 대상으로 삼을 수 있음
5. **repo-embedded → standalone 마이그레이션 경로** — 기존 세팅을 프로젝트 모델로 래핑하는 절차 (populate 전략 `clone` → `worktree-cache` 수렴 포함)
6. **후속 ADR** — `2026-05-04_single-repo-orchestrator.md`("1 repo = 1 instance")와의 관계를 "1 project = 1 instance"로 정밀화하는 결정 기록

해소된 항목 (2026-08-11): 클론 캐시 운영·브랜치 네임스페이스 → D4·D8 및 "클론 캐시 운영 상세" 섹션. 프로젝트 env 선언 → D9.

## Spec Conformance 요약

| 항목                        | 분류                                                          |
| --------------------------- | ------------------------------------------------------------- |
| 외부 WORKFLOW.md            | **Conforming** — §5.1 우선순위 1번. soft expectation만 문서화 |
| `repository` 확장 키        | **Conforming** — §5.3 확장 규칙                               |
| `workspace.root`로 .runners | **Conforming** — §5.3.3, §9.1                                 |
| 빌트인 worktree populate    | **Conforming** — §9.3 implementation-defined                  |
| 스킬/MCP 주입               | **스펙 밖 확장** — 스펙은 스킬·MCP 개념 없음                  |
| 수퍼바이저                  | **스펙 밖 확장 레이어** — §2.2 Non-Goals가 상위 배치를 유도   |
| 브랜치 네임스페이스 (D8)    | **스펙 밖** — 스펙은 VCS 워크플로우를 규정하지 않음 (§9.3)    |
| 오케스트레이터 변경         | **없음** — 단일 프로젝트 프로세스 유지                        |

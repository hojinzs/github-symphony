# ADR: `claude -p` runtime 지원 추가 (multi-runtime 추상화)

- **Date**: 2026-04-15
- **Status**: Proposed
- **Revisions**:
  - 2026-04-15 r1 — initial draft
  - 2026-04-15 r2 — permission preset 3종 + legacy 역매핑 추가
  - 2026-04-15 r3 — Codex 리뷰 반영, v1 범위로 슬림 재작성 (범위 축소 내역은 §11 참조)
  - 2026-04-15 r4 — 선(先)결정 5건 반영: `tool-github-graphql` 중립 패키지 분리(P1 선행), MCP 합성 hybrid, session 계층별 처리(intra-run resume / inter-run fork), broker contract에 `expires_at?` 추가, isolation knob(`--bare`/`--strict-mcp-config`) opt-in화. 자세한 변경 포인트는 §11 의 "r4 신규 결정" 참조.
- **Related Spec**: `docs/symphony-spec.md` §5 (Workflow), §10 (Runtime Events), §13 (Runtime Snapshot)
- **References**:
  - Anthropic Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
  - Anthropic headless / Agent SDK (CLI) guide: https://code.claude.com/docs/en/headless
  - Anthropic permission modes: https://code.claude.com/docs/en/permission-modes

---

## 1. Context

현재 구현은 AI coding agent 런타임으로 **Codex app-server (JSON-RPC daemon)** 하나만 실행한다. `packages/worker/src/index.ts:555 runCodexClientProtocol`이 `thread/start` → multi `turn/*` → `shutdown` 루프를 전제로 하고, `packages/runtime-codex/src/runtime.ts:136`이 기본 명령을 `codex app-server`로 박아 둔다. 저장소 곳곳의 `"claude-code"` 문자열은 authoring / skill 디렉터리 경로만 인지하는 수준이고 실제 실행 경로는 없다.

Anthropic `claude -p` (non-interactive CLI) 런타임을 추가 지원하려면 command 교체만으로는 부족하다. 프로세스 수명주기, credential 모델, MCP 연결 방식, WORKFLOW.md 노출 방식이 모두 다르다.

본 ADR은 **"현재 Codex 경험을 Claude로도 동일하게 사용할 수 있게 한다"** 는 한 가지 성공조건만 목표로 한다. 권한 추상화, 자동 allowlist 생성, legacy 역매핑 등은 의도적으로 범위에서 제외한다 (§11 참조).

## 2. Upstream Spec과의 관계

`docs/symphony-spec.md`는 **수정하지 않는다**. 본 ADR 내용은 repo-local divergence로 취급한다.

spec / contract에 이미 박혀 있는 codex 심볼(`OrchestratorChannelCodexUpdateEvent`, `codexTotals`, `codex_totals`, `WorkflowCodexConfig`, `DEFAULT_CODEX_COMMAND` 등)은 본 ADR에서 이름을 바꾸지 않는다. Claude 런타임 데이터도 당분간 이 이름 아래 흐르는 것을 감수한다. 이름 정리는 별도 follow-up ADR에서 다룬다.

## 3. `claude -p` 공식 계약 (2026-04-15 문서 확인)

### 3.1 기본 argv (default, 항상 포함)

| Flag | 이유 |
|---|---|
| `-p` / `--print` | non-interactive 실행 |
| `--output-format stream-json` + `--input-format stream-json` | NDJSON 이벤트 / 멀티 메시지 주입 |
| `--include-partial-messages` + `--verbose` | delta token 이벤트 포함 |
| `--permission-mode bypassPermissions` | 현행 Codex `danger-full-access`와 기능적 등가. isolated workspace 전제 (§4.4) |
| `--session-id <uuid>` / `--resume <id>` / `--fork-session` | 턴/런 간 세션 관리 (§4.2) |

### 3.2 Isolation opt-in 플래그 (§4.8)

기본 argv 에는 포함되지 않고 WORKFLOW.md `runtime.isolation` 에서 선택하는 플래그.

| Flag | 효과 | 기본 | 선택 방법 |
|---|---|---|---|
| `--bare` | hooks / skills / plugins / auto memory (`CLAUDE.md`) 자동 discovery 스킵 | **off** | `runtime.isolation.bare: true` |
| `--strict-mcp-config --mcp-config <f>` | 모든 MCP auto-discovery 차단, `<f>` 만 로드 | **off** | `runtime.isolation.strict_mcp_config: true` |

### 3.3 주요 제약

- **Slash skill 비가용**: 공식 문서 원문 — *"User-invoked skills like `/commit` and built-in commands are only available in interactive mode."* `-p` 모드에서는 `.claude/skills/*` 가 user-invocable slash command로 호출되지 않는다. `--bare` 여부와 무관한 CLI 제약.
- **OAuth/keychain**: `--bare` on 일 때(그리고 `apiKeyHelper` 미설정 시)는 `ANTHROPIC_API_KEY` 필수. `--bare` off 에서는 로컬 Claude Code 로그인도 사용 가능.
- **One-shot per invocation**: Codex app-server 같은 장기 JSON-RPC daemon이 아니다. 매 턴마다 새 프로세스 (§4.2).

## 4. Decision

### 4.1 단계적 도입

| Phase | 범위 | 완료 조건 |
|---|---|---|
| **P1.0 — 선행 분리** | `packages/tool-github-graphql/` 신설. 현 `packages/runtime-codex/src/github-graphql-tool.ts` / `github-graphql-mcp-server.ts` 및 테스트 이동. `runtime-codex` 가 새 패키지를 dependency 로 참조. | import path 외 기능 변경 없음. Codex regression 없음. |
| **P1 — Adapter 추상화** | `packages/core`에 `AgentRuntimeAdapter` 인터페이스 도입(spawn-loop 계약 포함), 기존 `runtime-codex`를 해당 인터페이스 뒤로 이식. worker는 어댑터만 의존. | 기능 변경 없음. Codex regression 없음. |
| **P2 — `runtime-claude` 신설** | `packages/runtime-claude` 추가. `claude -p` one-shot invocation 루프로 `AgentRuntimeAdapter` 구현. credential 소비 분기(§4.3), MCP 합성(§4.6.2), session 관리(§4.2), `doctor` / `init` preflight 확장(§4.5). | stub `claude` 바이너리로 Docker E2E 1개 이슈 처리 완료. |
| **P3 — `runtime.kind` front-matter** | WORKFLOW.md에 `runtime:` 블록 도입 (§5.2). 기존 `codex:` 블록은 하위호환 유지. | runtime 선택이 1급 설정으로 승격. |

### 4.2 Worker 프로세스 모델 분기

- **Codex app-server**: 기존 `runCodexClientProtocol` 유지.
- **Claude `-p`**: **one-shot per Symphony turn**.
  1. 첫 턴: `--session-id <generated-uuid>` 고정 발급, session id 저장 (§4.2.1).
  2. 같은 run 내 turn 재시도 (**intra-run retry**): `--resume <session-id>`. 직전 실패 context 유지로 같은 실수 반복 방지.
  3. orchestrator 의 run 재dispatch (**inter-run recover**): 이전 run 의 session id 를 읽고 `--resume <session-id> --fork-session` 으로 새 session 발급. 누적 오염 끊고 cache 비용 리셋.
  4. `--output-format stream-json --include-partial-messages --verbose` 로 NDJSON 이벤트 수신.
  5. exit code + 최종 event 로 turn 결과 판정 (§4.2.2).

기존 `thread-resume.ts`, `turn-limits.ts`, `convergence-detection.ts`는 P1 adapter 인터페이스에 맞춰 **"프로세스 spawn 루프"** 로 재해석한다.

#### 4.2.1 Session id 저장

- 경로: `.runtime/orchestrator/runs/<run-id>/claude-session.json`
- 내용: `{ sessionId: string, createdAt: ISO8601, parentRunId?: string }` — `parentRunId` 는 inter-run recover 시 이전 run 링크용.
- 읽기 실패 / 세션 만료(`--resume` 4xx) 시 fallback: 새 `--session-id` 발급(fork 없이), `parentRunId` 로 링크 유지. run event 에 `session_invalidated` 를 로깅.

#### 4.2.2 Exit code 규칙

| Claude exit | 최종 `result` event | 해석 | 다음 행동 |
|---|---|---|---|
| 0 | `success` | turn 성공 | run continuation 정책 적용 |
| 0 | `error_*` | turn 내 application-level 실패 | `turn/failed` emit, retry 규칙 위임 |
| non-0 | (없음 / SIGTERM) | process-level 실패 (API error, rate limit, misconfig) | transient 여부 판별 후 retry 또는 run 실패 |

구체 이벤트 이름별 매핑 테이블은 구현 이슈(#6)에서 확정.

### 4.3 Credential 모델

- `AgentRuntimeAdapter` 에 `resolveCredentials(brokerResponse): RuntimeEnv` 슬롯을 둔다.
- **Broker contract 확장 (additive)**: 응답 schema 를 `{ env: Record<string, string>, expires_at?: string (ISO8601) }` 로 확장. `expires_at` 미지정이면 lifetime 재사용으로 폴백 (legacy broker 호환).
- **소비 측 분기** — broker 응답에서 런타임이 자기 필요한 env key 만 추출:
  - Codex: `OPENAI_API_KEY`, `OPENAI_BASE_URL` 등 기존 소비 로직 유지.
  - Claude: `ANTHROPIC_API_KEY`. 없으면 preflight 단계에서 명확한 에러.
- **캐시**: 현 `agentCredentialCachePath` 파일에 `expires_at` 포함 payload 저장. `TOKEN_REUSE_WINDOW_MS` 직전이면 재사용, 만료되면 broker 재호출.
- Codex 전용 자산(`CODEX_HOME` 스테이징)은 그대로 유지.

### 4.4 Permission 모델 (v1 단일 프리셋)

v1은 **`permissive` 동작만 지원**한다. Claude는 `--permission-mode bypassPermissions`, Codex는 기존 `approval_policy: never` + `thread_sandbox: danger-full-access` (현재 `packages/worker/src/codex-policy.ts:18-24` 기본값 그대로).

선택 근거:

1. **Symphony 워커는 "human 개입 = 실패"로 동작한다** (`packages/worker/src/index.ts:891-920`에서 `turnParams.inputRequired === true` 시 즉시 SIGTERM + run failure). 따라서 Codex의 `on-request` / Claude의 `default`·`acceptEdits` 처럼 "사람에게 물어보는" 모드는 orchestrator 맥락에서 의미가 없다.
2. 현재 Codex 경험이 이미 `danger-full-access`다. Claude 도입이 곧 퇴행이 되면 안 된다.
3. Symphony는 per-issue `.runtime/symphony-workspaces/<id>/` throwaway clone + Docker E2E 전제로 운영된다. Anthropic 문서가 `bypassPermissions` 권장 조건으로 제시하는 "isolated environments" 를 충족한다.

권한을 좁히고 싶은 사용자는 **`runtime.kind: custom`** 으로 argv를 직접 기입한다. 정식 preset(예: strict-ci / safe-edits)은 실수요가 쌓인 뒤 별도 ADR에서 다룬다.

**문서화 고정 문구** — WORKFLOW.md generator가 Claude 런타임 선택 시 자동 삽입:

> **Permissive preset requires an isolated workspace.** Symphony runs each issue in `.runtime/symphony-workspaces/<workspace-id>/`, a throwaway clone. If you disable workspace isolation or mount host paths into worker containers, do not use this runtime in production.

### 4.5 Preflight readiness (v1 필수)

실행 중 blocker 코멘트만으로는 "시작 전에 깨지는" 흔한 케이스를 막을 수 없다. 따라서 다음을 **v1 필수**로 포함한다.

- `doctor` 확장 (`packages/cli/src/commands/doctor.ts:1011` 분기 확장):
  - `claude` 바이너리 존재 / 버전.
  - `ANTHROPIC_API_KEY` 설정 여부 또는 credential broker 도달성 (Claude 선택 시에만).
  - 워크스페이스 루트 `.mcp.json` 의 읽기 가능성 (없어도 OK, 읽기 실패는 warn).
  - `gh` 인증 상태 (Codex와 공통).
- `init` 은 runtime 선택 직후 위 항목을 로컬에서 한 번 실행해 사람 읽기 쉬운 오류를 출력한다.
- 워커는 시작 시점에도 같은 체크를 수행하고, 실패 시 exit code + log 로 명시 (blocker 코멘트 이전 단계).

### 4.6 GitHub GraphQL tool — 중립 패키지 + MCP 합성

#### 4.6.1 중립 패키지로 재배치 (P1.0 선행)

현 `packages/runtime-codex/src/github-graphql-tool.ts` 와 `github-graphql-mcp-server.ts` 는 **런타임 중립 자산**이다 (Codex 관련 로직 없음, 단순 GraphQL 래퍼 + MCP stdio server). P1.0 선행 이슈에서 `packages/tool-github-graphql/` 패키지로 이동. 두 런타임 어댑터는 새 패키지를 dependency 로 참조.

근거: `runtime-claude` 가 `runtime-codex` 에 의존하는 import 그래프는 어댑터 추상화의 취지를 훼손한다.

#### 4.6.2 MCP config 합성 (Claude 전용)

Worker 초기화 단계에서 symphony-required MCP (`github_graphql`) 를 사용자 `.mcp.json` 과 병합한다. 최종 파일 위치와 argv 는 `runtime.isolation.strict_mcp_config` 에 따라 분기:

| `strict_mcp_config` | 병합 결과 위치 | argv 추가 |
|---|---|---|
| **false (default)** | 워크스페이스 루트 `.mcp.json` 에 mutation 으로 merge. 워크스페이스는 throwaway clone 이므로 오염 영향 없음. | 없음 (Claude auto-discovery 가 픽업) |
| true | `.runtime/<workspace>/mcp.json` (ephemeral) | `--strict-mcp-config --mcp-config <path>` |

병합 규칙:
- Base: 워크스페이스 루트 `.mcp.json` 이 있으면 그 내용, 없으면 `{ mcpServers: {} }`.
- Overwrite: `mcpServers.github_graphql` 키를 symphony-managed 값으로 덮어씀 (command path / env / token 을 런타임 값으로 결정).
- User-authored 다른 키는 보존.

Codex 런타임은 기존 `CODEX_HOME` 스테이징을 유지하고 MCP 합성을 거치지 않는다.

### 4.7 Prompt 분기

`generate-workflow-md.ts`는 Claude 런타임 선택 시 prompt body 상단에 아래 섹션을 삽입한다.

```md
### Runtime Constraints

1. This run uses `claude -p` in non-interactive mode.
2. Slash commands such as `/commit`, `/push`, `/gh-project`, `/gh-pr-writeup` are NOT available (CLI limitation, independent of isolation settings).
3. Use `gh`, `git`, repository scripts, and configured MCP tools directly instead.
4. If a required permission or tool is unavailable, post a blocker comment on the issue and exit. Do not wait for human input.
```

Codex 런타임 prompt는 현행 유지.

### 4.8 Isolation knobs (opt-in)

운영자 개인 환경(`~/.claude/`, 커스텀 MCP) 및 팀 자산(`CLAUDE.md`, `.claude/skills/`) 의 worker 노출 여부는 **팀 정책**이지 프레임워크 default 가 아니다. 두 knob 으로 노출:

| Knob | off (default) — Claude Code 네이티브 | on — 격리 |
|---|---|---|
| `runtime.isolation.bare` | `CLAUDE.md` 자동 주입, skills/hooks/plugins discovery 활성 | argv 에 `--bare` 추가 — discovery 모두 스킵 |
| `runtime.isolation.strict_mcp_config` | 사용자 `.mcp.json` + `~/.claude` MCP 모두 로드. Symphony MCP 는 워크스페이스 `.mcp.json` merge 로 공급 (§4.6.2) | argv 에 `--strict-mcp-config --mcp-config <ephemeral>` 추가. Symphony-merged ephemeral 만 로드 |

Default 근거:
- `bypassPermissions` 를 v1 default 로 놓은 §4.4 와 동일 철학: "넓게 시작, 좁힐 팀이 명시 opt-in".
- 팀이 `CLAUDE.md`, `.claude/skills/` 를 쓸 때 그걸 의도적으로 무시하는 것이 더 큰 surprise.
- 멀티 테넌트 / CI 환경에서 격리가 필요한 팀은 2줄 opt-in 으로 전환.

Trade-off 고지 — WORKFLOW.md generator 가 Claude 런타임 선택 시 주석으로 삽입:

> Isolation is off by default — the agent will pick up your `CLAUDE.md`, project skills, and personal MCPs from `~/.claude/`. Turn isolation on when running in multi-operator CI, shared infrastructure, or when reproducibility across machines matters.

## 5. WORKFLOW.md schema (v1)

### 5.1 단기 호환 (P1-P2)

기존 `codex:` 블록 재사용. 명령 문자열만 교체.

```yaml
codex:
  command: >-
    claude -p
    --output-format stream-json --input-format stream-json
    --verbose --include-partial-messages
    --permission-mode bypassPermissions
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
  stall_timeout_ms: 900000
```

Parser 변경 없음. Isolation flag (`--bare` / `--strict-mcp-config`) 는 필요 시 수동 추가.

### 5.2 정식 (P3)

`runtime:` 블록 도입. 구 `codex:` 블록은 deprecated alias 로 유지.

```yaml
runtime:
  kind: claude-print            # codex-app-server | claude-print | custom
  command: claude
  args:
    - -p
    - --output-format
    - stream-json
    - --input-format
    - stream-json
    - --verbose
    - --include-partial-messages
    - --permission-mode
    - bypassPermissions
  isolation:
    bare: false                  # true 시 --bare 자동 추가
    strict_mcp_config: false     # true 시 --strict-mcp-config + ephemeral --mcp-config 자동 주입
  auth:
    env: ANTHROPIC_API_KEY
  timeouts:
    read_timeout_ms: 5000
    turn_timeout_ms: 3600000
    stall_timeout_ms: 900000
```

Parser는 `runtime:` 우선, 없으면 기존 `codex:` 로 폴백. **legacy → preset 역추론은 하지 않는다**. 구 설정은 구 설정 그대로 해석한다.

Session resume 동작(§4.2)은 **schema 에 노출하지 않는다**. intra-run `--resume` / inter-run `--fork-session` 은 프레임워크 default. 실수요 발생 시 후속 ADR.

## 6. User stories

- As a repository maintainer, WORKFLOW.md만 편집해서 Codex ↔ Claude 런타임을 전환할 수 있다.
- As a team lead, `.mcp.json` / `CLAUDE.md` / `.claude/skills/` 를 커밋하면 worker 가 그대로 활용한다. 격리가 필요하면 `runtime.isolation` 2줄로 켠다.
- As an orchestrator operator, 런타임 종류와 무관하게 같은 run lifecycle / session id / `lastEventAt` / token usage 를 본다.
- As a new Claude user, `gh-symphony init` 또는 `gh-symphony doctor` 가 **시작 전에** 필요한 준비물(바이너리, API 키, gh 인증)을 한 번에 알려준다.
- As a retry/recovery flow, worker 가 intra-run 은 `--resume` 으로 context 유지, inter-run recover 는 `--fork-session` 으로 누적 오염 끊는다.

## 7. Test plan

- Unit: `AgentRuntimeAdapter` 인터페이스 정합성, `runtime-claude` 의 argv 조립 (isolation off/on 분기 포함), session id 저장/복구.
- Unit: `parseWorkflowMarkdown` 이 `runtime.kind=claude-print` + `runtime.isolation` 블록 허용하고 legacy `codex:` 블록과 공존.
- Unit: Claude NDJSON 이벤트 → `OrchestratorChannelEvent` 정규화 + exit code 분류 (§4.2.2).
- Unit: MCP 합성 — (a) user `.mcp.json` 없는 경우, (b) 있는 경우, (c) `strict_mcp_config=true` 일 때 ephemeral 경로 생성.
- Unit: credential — broker 응답 `{env, expires_at?}` 캐시 hit/miss, Claude 는 `ANTHROPIC_API_KEY` 만 추출.
- Unit: `doctor` 가 missing binary / missing `ANTHROPIC_API_KEY` / gh 미인증을 각각 사람 읽기 쉬운 메시지로 보고.
- Integration: stub `claude` 바이너리(Bash shim)로 worker 가 `Ready → In progress → In review` 전이.
- E2E (Docker): `AGENT_TEST.md` 환경에서 Claude stub 으로 한 이슈를 end-to-end 처리, intra-run retry 경로에서 `--resume` 유지 / inter-run recover 경로에서 `--fork-session` 동작.
- Regression: 기존 Codex 경로 변동 없음 (P1.0 + P1 merge gate).

## 8. Open questions

r4 에서 해소된 항목:

- ~~`.gh-symphony/claude-mcp.json` 생성 주체~~ → **해소**: Symphony 전용 파일 만들지 않음. 워크스페이스 루트 `.mcp.json` 을 base 로 삼아 worker 가 합성 (§4.6.2).
- ~~`--fork-session` 기본값~~ → **해소**: intra-run retry = `--resume` (fork 없음), inter-run recover = `--resume + --fork-session`. schema 노출 없음 (§4.2).
- ~~API key 회전 정책~~ → **해소**: broker response 에 `expires_at?` 추가, 캐시 hit/miss 로 rotation (§4.3).
- ~~Isolation default~~ → **해소**: `--bare` / `--strict-mcp-config` 모두 default off, knob opt-in (§4.8).

잔여:
1. stream-json 이벤트 이름별 정규화 테이블 구체안 (구현 이슈 #6 본문에서 확정).
2. stub `claude` Bash shim 입출력 계약 (구현 이슈 #9 본문에서 확정).

## 9. Naming debt / follow-up (deferred)

본 ADR 범위 외. 별도 ADR에서 다룬다.

- `OrchestratorChannelCodexUpdateEvent` / `codex_update` 이벤트 타입
- `codexTotals` / `codex_session_logs` status surface 필드
- `WorkflowCodexConfig` / `DEFAULT_CODEX_COMMAND`
- `symphony-spec.md §4.1.8 codex_totals` — upstream spec 문서이므로 수정 금지. 해석상 "active runtime의 aggregate"로 본다.

## 10. Consequences

### Positive
- 런타임 추상화 + `tool-github-graphql` 분리로 Bun, Rust 등 추가 런타임도 동일 계약으로 꽂을 수 있다.
- Isolation knob 2개가 "재현성 vs 팀 자산 활용" 트레이드오프를 팀 정책 차원에서 결정 가능하게 한다.
- `init` + `doctor` 의 preflight readiness 가 "blocker 코멘트 이후" 대응을 "로컬 오류 메시지" 로 전방 배치한다.
- Credential broker contract 확장이 additive 라 기존 배포 깨지 않음.

### Negative
- worker multi-turn 루프가 "프로세스 spawn 루프" 로 재설계되어야 하므로 P1 선행이 필수. P1 없이 P2 에 진입하면 변경 폭이 위험하게 커진다.
- Claude 쪽은 `--bare` off 일 때 OAuth/keychain 활용 가능하지만 on 이면 `ANTHROPIC_API_KEY` 필수 — 두 경로 모두 테스트 필요.
- `codex_*` 네이밍이 당분간 Claude 런타임 데이터에도 사용되어 일시적 의미 debt 가 남는다.
- `permissive` 단일 모드가 v1 의 전부이므로, 보안 강화를 원하는 팀은 `custom` 으로 직접 argv 를 관리해야 한다.
- Default isolation off 는 "Claude Code 네이티브 경험" 을 제공하지만 운영자 환경 간 재현성이 팀 정책에 의존한다. 팀이 isolation on 을 명시적으로 켜야 reproducibility 가 보장됨.

### Neutral
- Symphony upstream spec은 변경하지 않고, 본 ADR을 repo-local extension으로 공식화한다.

---

## 11. 이전 revision 에서 제외 / 유지 / 추가한 항목

### 11.0 r4 신규 결정

- **`tool-github-graphql` 중립 패키지 분리** (§4.1 P1.0, §4.6.1) — runtime-claude 가 runtime-codex 에 import 의존하는 그래프 회피.
- **MCP 합성 hybrid** (§4.6.2) — 사용자 `.mcp.json` 을 base 로, `strict_mcp_config` 값에 따라 워크스페이스 mutation 또는 ephemeral 로 분기. `.gh-symphony/claude-mcp.json` 같은 Symphony 전용 파일은 만들지 않음.
- **Session 계층별 처리** (§4.2) — intra-run retry 는 `--resume`, inter-run recover 는 `--resume + --fork-session`. schema 미노출.
- **Broker response `expires_at?` 추가** (§4.3) — additive. legacy broker 폴백 보장.
- **Isolation knobs `runtime.isolation.bare` / `strict_mcp_config`** (§3.2, §4.8, §5.2) — 둘 다 default off. 팀이 opt-in.

### 11.1 r3 에서 제외한 항목 (r4 유지)

r3 재작성 시점에 Codex 리뷰 및 사용자 원칙("심플해야 한다") 을 반영해 다음을 **v1 범위 밖**으로 이동했다. r4 에서도 그대로 유효.

#### 제외 1: Permission preset 추상화 (`permissive` / `safe-edits` / `strict-ci` / `custom`)

- **r2에 있던 내용**: `runtime.permission.preset` 필드와 3-preset 표. Claude `acceptEdits` / `dontAsk` 와 Codex `on-request` / `workspace-write` / `read-only` 를 같은 preset 이름 아래 묶는 설계.
- **제외 사유**:
  1. Symphony 워커는 `packages/worker/src/index.ts:891-920` 에서 "user input 요청 시 즉시 SIGTERM + 실패" 로 동작한다. 따라서 `on-request` / `acceptEdits` 같은 "사람에게 물어보는" 모드는 orchestrator 맥락에서 의미가 없고, Codex 쪽 `safe-edits` / `strict-ci` 는 **사실상 실행 불능**이다. 같은 이름으로 포장하면 사용자에게 거짓 대칭을 약속하게 된다.
  2. v1 성공조건 ("Codex 경험을 Claude로 그대로") 을 달성하는 데 `permissive` 하나로 충분하다.
- **v1 처리**: `permissive` 동작만 지원. 좁히고 싶으면 `runtime.kind: custom` 으로 argv 직접 기입 (§4.4).
- **후속**: 실수요가 쌓이면 별도 ADR. 그때는 preset 이름을 **런타임별로 다르게** 두고 공통 추상화를 포기할 가능성이 높다.

#### 제외 2: `runtime.permission.extra_allow` / `extra_deny`

- **r2에 있던 내용**: 프로젝트별 allowlist 확장 / deny 룰 확장을 YAML 에서 선언.
- **제외 사유**: preset 추상화가 빠지면서 붙일 자리가 없다. `extra_deny` 는 Codex 쪽 대응 개념이 없어 런타임별 기능 차이가 발생한다.
- **v1 처리**: `custom` argv 에 직접 `--allowedTools` / `--disallowedTools` 기입.
- **후속**: preset ADR 과 함께 재검토.

#### 제외 3: `safe-edits` 자동 allowlist 생성 (detectEnvironment 기반)

- **r2에 있던 내용**: `detectEnvironment` 결과로 `Bash(<packageManager> *)`, `Bash(<testCommand prefix> *)` 등을 자동 생성.
- **제외 사유**: 실제 탐지기(`packages/cli/src/detection/environment-detector.ts`) 는 `package.json` 의 `scripts` raw 문자열과 package manager 정도만 안다. Monorepo, Makefile, justfile, Docker 기반 테스트, shell wrapper 에서는 오탐 / 누락이 잦다. preset 자체가 빠진 이상 부속 기능도 함께 제외한다.
- **v1 처리**: 없음.
- **후속**: preset ADR 에서 재검토. 자동 생성보다는 `init` 시 스캐폴드 파일을 열어 사용자가 직접 편집하는 쪽이 현실적일 수 있다.

#### 제외 4: Legacy `codex:` 설정 → preset 역매핑

- **r2에 있던 내용**: 구 WORKFLOW.md 의 `thread_sandbox: danger-full-access` 같은 값을 보고 `permissive` preset 으로 자동 라벨링.
- **제외 사유**: 현재 `codex:` 블록은 `command` / `approval_policy` / `thread_sandbox` / `turn_sandbox_policy` / 타임아웃이 각각 독립 필드다. 이 중 하나만 보고 preset 라벨을 붙이면 실제보다 안전해 보이거나 더 엄격해 보이는 **오해를 부를 수 있다**. preset 자체가 v1 에 없으므로 역매핑도 불필요.
- **v1 처리**: parser 는 `runtime:` 블록 있으면 우선, 없으면 `codex:` 블록 그대로 해석. 라벨 추론 없음.
- **후속**: preset ADR 도입 시 다시 검토. `doctor` 가 "legacy 설정 감지, 명시 preset 을 추가하세요" 경고만 띄우는 선이 안전하다.

#### 제외 5: `--exclude-dynamic-system-prompt-sections`

- **r1에 있던 내용**: 다수 이슈 병렬 처리 시 prompt cache hit rate 향상을 위해 해당 플래그를 기본 argv 에 포함하는 안.
- **제외 사유**: v1 성공조건과 무관한 성능 최적화. 구체 운영 가이드 (설정 경로, 측정 방법) 도 미정의 상태였다.
- **v1 처리**: 없음.
- **후속**: 토큰 비용이 실제로 문제되면 별도 최적화 ADR 에서.

#### 제외 6: `max-turns` 의미 정의 상세

- **r1에 있던 내용**: Claude `--max-turns` (invocation 내부 loop) vs Symphony `agent.max_turns` (continuation 횟수) 매핑 규칙.
- **제외 사유**: v1 에서는 Claude `--max-turns` 를 설정하지 않고 Claude 기본값에 위임한다. Symphony `agent.max_turns` 는 기존 의미 그대로(프로세스 재호출 횟수 상한) 사용. 매핑 규칙을 지금 못박을 필요가 없다.
- **v1 처리**: Claude argv 에 `--max-turns` 포함하지 않음.
- **후속**: 실제 runaway 사례가 나오면 그때 정의.

### 11.2 유지된 핵심 항목 (r3 → r4)

- runtime adapter 추상화 (§4.1 P1) — 핵심.
- `runtime-claude` 패키지 (§4.1 P2) — 핵심.
- `runtime.kind` front-matter (§4.1 P3, §5.2) — 핵심.
- `doctor` preflight readiness (§4.5) — v1 필수.
- `permissive` 동작 단일 지원 (§4.4).
- prompt body 에 slash command 금지 안내 (§4.7).
- credential broker (§4.3) — r4 에서 contract 명시화.
- GitHub GraphQL MCP 재사용 (§4.6) — r4 에서 중립 패키지 재배치 + 합성 분기로 확장.

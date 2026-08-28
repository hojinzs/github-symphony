# Configuration Reference

This page is the operator-facing reference for environment variables that
GitHub Symphony reads directly or injects into worker runtimes. Prefer
committed `WORKFLOW.md` settings for workflow policy, and use environment
variables for host-specific authentication, Enterprise endpoints, local paths,
and operational overrides.

## WORKFLOW.md Reload Semantics

The orchestrator does not need a restart to apply a valid `WORKFLOW.md` edit.
It defensively reads and resolves the file during every reconciliation tick;
the next tick applies updated polling, concurrency, lifecycle, runtime, path,
hook, and future-prompt configuration. The current tick completes using its
already-resolved policy. Because polling is capped at five minutes, the maximum
normal delay before an edit is observed is five minutes. A change that lowers
`polling.interval_ms` first waits for the outstanding tick at the old interval,
then uses the new interval.

There is intentionally no `fs.watch`/`chokidar` watcher. This is a
repository-local divergence from upstream Symphony §6.2 and §16.1: the
repository meets the defensive detection/re-read acceptance behavior but does
not provide immediate event-driven re-application. The status snapshot records
the effective `workflow.revision` (a short SHA-256-derived identifier) and
`workflow.loadedAt`; `run-dispatched` structured events record the same
`workflowRevision`. Neither value contains workflow contents or environment
values. See [ADR 2026-08-26](adr/2026-08-26-workflow-reload-divergence.md) for
the decision and scope.

Human-readable `gh-symphony repo status`, `gh-symphony project status`, and
their `--watch` dashboards show the applied revision; `--json` exposes the
same metadata for automation.

## WORKFLOW.md Front-matter Validation

`gh-symphony workflow validate` and `gh-symphony repo doctor` use the same
strict parser as workflow loading. Failures include a stable error code; the
`workflow validate --json` error also exposes its field path separately.

| Rule                | Required value                                                                                                             | Error code/path                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Front matter syntax | A valid YAML mapping                                                                                                       | `workflow_parse_error` or `workflow_front_matter_not_a_map` at `front_matter` |
| Numeric fields      | YAML integers; quoted numeric strings and fractions are rejected, including priority maps and per-state concurrency values | `workflow_validation_error` at the field path                                 |
| `hooks.timeout_ms`  | A positive integer when provided                                                                                           | `workflow_validation_error` at `hooks.timeout_ms`                             |
| `agent.max_turns`   | A positive integer when provided                                                                                           | `workflow_validation_error` at `agent.max_turns`                              |
| `codex.command`     | A non-empty string when provided                                                                                           | `workflow_validation_error` at `codex.command`                                |
| `tracker.kind`      | One of `github-project`, `linear`, or `file`                                                                               | `workflow_validation_error` at `tracker.kind`                                 |

Omitted optional values retain their documented defaults. Per-state concurrency
maps remain supported through `agent.max_concurrent_agents_by_state` and their
values must be positive YAML integers. This repository intentionally rejects an
invalid override rather than ignoring it, so invalid configuration cannot silently
disable dispatch for a state.

## Workflow Lifecycle Policy

`tracker.blocker_check_states` selects the workflow states where unresolved
`blocked_by` dependencies prevent dispatch. When the field is omitted, the
default is `["Todo"]`, matching the Symphony candidate-selection rule. Set an
explicit empty list (`blocker_check_states: []`) only when blocker gating should
be disabled. This opt-out is an intentional repository-level divergence from
the vendored Symphony specification's unconditional blocker rule. Omitting
`planning_states` keeps planning disabled; blocker defaults do not enable the
planning/human-review execution phase. Linear `blocked_by` metadata is derived
from inverse relations of type `blocks`; source-side relations describe issues
blocked by the current issue and are not blockers of it.

## `GH_SYMPHONY_CONFIG_DIR` and Repository Runtimes

`GH_SYMPHONY_CONFIG_DIR` (or `--config <dir>`) selects the shared CLI registry
used by repository lifecycle commands. `gh-symphony repo init` always writes the
repo-embedded runtime under `<repo>/.runtime/orchestrator`; when a config
directory is explicitly selected, it also writes a repository-path-scoped project
record and makes that record active under the directory. This keeps a subsequent
`gh-symphony repo start` in the same environment consistent with initialization.
Records for other repositories in the same shared directory are preserved; each
subsequent `repo init` makes its own repository the active project.
Without an explicit config directory, repository lifecycle commands use the
repo-embedded runtime directly. The environment variable does not relocate the
repository's orchestrator state.

## Standalone Projects

`gh-symphony project start` runs the project folder in the working directory as
an independent orchestration instance; `--project-dir <path>` names a different
folder. The folder owns `WORKFLOW.md`, optional `.mcp.json`, `.env`, and
`.agent/skills/`; the referenced repository remains unmodified. `WORKFLOW.md`
must declare `repository.slug`, which is also what distinguishes a standalone
project from a repository that embeds its own workflow. Configuration is derived
from the folder on every start and cached under
`<config-dir>/projects/<project-id>/`, where the project id is a stable function
of the folder path — there is no registration step, and folder-addressed lifecycle does not rely
on active-project state.
Folder-addressed lifecycle commands do not consult `activeProject`. Diagnostics have a separate
selection rule: an explicit selector wins, then an exact registered `projectDir` match for the
working directory, then the global registry's `activeProject` as a fallback.
The cached `projectDir` is always absolute; persisted relative values are
rejected instead of being resolved against the daemon working directory. Issue workspaces are
created under the project's `workspace.root` (spec 9.1), resolved relative to
the project folder and defaulting to `<project-dir>/.runtime/workspaces`; the
directory is created with mode `0700` when it does not exist. Repo-embedded
projects apply the same rule relative to the repository checkout. Their
orchestrator state remains under `.runtime/orchestrator`, while populated issue
workspaces live at `<workspace.root>/<sanitized-issue-identifier>`; when omitted,
`workspace.root` defaults to `.runtime/symphony-workspaces`. `repo init` creates
the resolved root with mode `0700`, and rejects a root that equals or contains
the repository checkout. Each issue is
populated from the shared bare cache at `<config-dir>/repos/<owner>/<repo>.git`
using a worktree. Branches default to
`symphony/<project-slug>/<sanitized-issue-id>`, so multiple projects may use
one repository without branch collisions. The project `.env` is loaded first
for project hooks and workers, then host process values override it; keep it
mode `0600` and do not commit it. Workflow reload caching compares a SHA-256
digest of the effective environment so project and host secret values are not
retained in plaintext cache metadata. An explicit `--config <dir>` is exported to
`GH_SYMPHONY_CONFIG_DIR` for the process, so the bare cache and spawned workers
use the same directory as the rest of the CLI state. The cache is keyed by
`<owner>/<name>`; when a project's clone URL changes, the cache re-points
`origin` and refetches on the next populate.
Cache operations heartbeat their repository lock once per minute so a healthy
large clone or fetch is not treated as stale. If the cache directory is
unavailable or its lock times out, workspace creation uses an isolated direct
clone. `gh-symphony cache status` inventories cache size and safety state;
`gh-symphony cache prune` applies an operator-triggered 30-day default age
policy and skips locked caches, linked worktrees, and unverifiable entries.

### Repo-embedded workspace-root migration

After upgrading an existing repo-embedded installation, `repo stop` remains
available for legacy metadata. Run it before `repo init` so project metadata records
the repository checkout and `workspace.root` separately. Existing issue
worktrees are not moved in place because their administrative paths are also
recorded in the shared bare cache. Startup rejects legacy metadata that still
uses `workspaceDir` as the repository checkout instead of risking workspace
population inside that checkout. Use this recoverable one-time reset:

```bash
gh-symphony repo stop
mv .runtime/orchestrator .runtime/orchestrator.pre-workspace-root
gh-symphony repo init
gh-symphony repo start
```

`repo init --workflow-file <path>` stores the resolved absolute path as the repository workflow source. Both `repo start` and `project start` validate that configured workflow before daemon startup; an invalid workflow exits with a clear preflight error instead of repeatedly failing dispatch ticks.

The first dispatch re-populates worktrees beneath the configured root. Keep the
archived directory until needed branches or uncommitted files have been
recovered; then remove it. Archiving the state and its cache together avoids
leaving stale `git worktree` registrations behind. If no reusable workspace
state exists, simply stopping, re-running `repo init`, and starting is enough.
If `workspace.root` is changed again later, dispatch emits both a structured
`workspace-root-relocated` event and a stderr warning naming the previous and
new paths before replacing the workspace record; inspect the previous path for
work to recover or delete.

When a standalone project targets a repository that also commits its own
`WORKFLOW.md`, the status surface reports a shadow warning naming the
repository. The repository file is never executed — only the registered project
policy is. The check reads the shared bare cache rather than the working
directory, so it reflects the repository as of the cache's last fetch and
catches up on the next issue populate.

## Workflow Lifecycle Phases

Tracker-specific settings belong in `tracker.provider`. Core preserves every
provider key without interpreting it, while the selected tracker adapter
validates that block. Older flat tracker keys remain supported as deprecated
aliases and are normalized into `provider`; new workflows should use the
provider block. `active_states` and `terminal_states` must be YAML lists (not
comma-separated strings) and must be configured explicitly unless the selected
adapter supplies lifecycle defaults.

`tracker.active_states` controls dispatch eligibility, while
`tracker.planning_states` classifies states for prompt policy and status
surfaces. Classification is independent of dispatch eligibility: a matching
planning state resolves to `planning` even when it is absent from
`active_states`. Both lists use trimmed, case-insensitive state matching.
Planning matching is evaluated before the active-state check; other matching
active states resolve to `implementation`, and unmatched states have no
execution phase.

The resolved value is exposed to the `WORKFLOW.md` prompt body as
`{{ execution_phase }}`. This field is classification, not an orchestration
gate: configure a Liquid conditional in the prompt when planning runs must not
implement. Existing prompts that do not reference the variable keep their
current behavior.

## Skill Layering

Before each worker attempt the orchestrator injects agent skills into the
issue worktree, merged from two layers with later layers overriding earlier
ones by skill directory name:

| Layer   | Source directory               | Notes                                     |
| ------- | ------------------------------ | ----------------------------------------- |
| Global  | `~/.gh-symphony/skills/`       | Shared across every project on the host   |
| Project | `<project-dir>/.agent/skills/` | Standalone project folder (or repository) |

The destination depends on the configured agent command: `.codex/skills/` for
Codex runtimes and `.claude/skills/` for Claude runtimes; unrecognized
commands skip injection. Skills already tracked by the repository are never
overwritten or deleted. Injected entries are recorded in a
`.gh-symphony-injected-skills.json` manifest inside the destination so a later
attempt can clean up only what Symphony wrote, and the runtime skills
directory is appended to the repository's `.git/info/exclude` so injected
skills never show up as untracked changes.

## Environment Loading Order

Worker and hook environments are merged in this order, with later values taking
precedence:

| Priority | Source                           | Applies to                                        |
| -------- | -------------------------------- | ------------------------------------------------- |
| 1        | Project `.env` file              | Hooks and worker processes                        |
| 2        | Orchestrator process environment | CLI, orchestrator, worker, runtime adapters       |
| 3        | Symphony-injected context        | Worker identity, issue metadata, runtime settings |

For standalone projects, the project `.env` lives in the registered external
project folder. For registry-backed or repo-embedded projects it lives at
`<config-dir>/projects/<project-id>/.env` (or the default config directory
when no `--config <dir>`/`GH_SYMPHONY_CONFIG_DIR` override is set).

## Auth And API Endpoints

These variables are user-facing and are safe to set in local shells, CI, or
container environments.

| Variable                 | Default                                                                                                          | Read by                                                                                 | Audience                                            | Notes                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_GRAPHQL_TOKEN`   | unset                                                                                                            | CLI, orchestrator, GitHub tracker, Codex runtime, Claude runtime, Git credential helper | User-facing                                         | Token-only GitHub auth source. Requires `repo`, `read:org`, and `project` scopes. Takes priority over `gh` CLI auth where both are supported.          |
| `GITHUB_GRAPHQL_API_URL` | unset; GitHub tooling falls back to the public GitHub GraphQL endpoint unless tracker config injects an endpoint | CLI doctor, Codex runtime, Claude runtime                                               | User-facing, GHES                                   | Process-level GraphQL endpoint override. For GHES, prefer `tracker.endpoint` in `WORKFLOW.md`; if both are set, keep them identical.                   |
| `GITHUB_PROJECT_ID`      | unset; injected from project config for workers                                                                  | Codex runtime, Claude runtime                                                           | Internal unless running a runtime launcher manually | Passed to GitHub GraphQL tooling so agent tools can target the active Project.                                                                         |
| `LINEAR_API_KEY`         | unset                                                                                                            | CLI, Codex runtime, Claude runtime                                                      | User-facing for Linear tracker projects             | Required for Linear repo startup. The built-in Linear MCP server receives it in its declared environment and uses it as the raw `Authorization` value. |
| `LINEAR_AUTHORIZATION`   | unset                                                                                                            | Codex runtime, Claude runtime                                                           | Advanced                                            | Optional raw Linear authorization value for the built-in Linear MCP server; it takes priority over `LINEAR_API_KEY`.                                   |
| `LINEAR_GRAPHQL_URL`     | `https://api.linear.app/graphql` when the Linear tool is enabled                                                 | Codex runtime, Claude runtime                                                           | User-facing for Linear Enterprise/proxy setups      | Overrides the Linear GraphQL endpoint.                                                                                                                 |

## Credential Brokers And Git Access

Use these when workers need short-lived credentials or when Git traffic must
target a non-`github.com` host.

| Variable                         | Default          | Read by                                              | Audience          | Notes                                                                                                                                                                                                     |
| -------------------------------- | ---------------- | ---------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN_BROKER_URL`        | unset            | Codex runtime, Claude runtime, Git credential helper | User-facing/ops   | Broker endpoint for GitHub tokens used by GitHub GraphQL tooling and Git credential resolution. When set with the secret, raw GitHub tracker aliases are removed from coding-agent children.              |
| `GITHUB_TOKEN_BROKER_SECRET`     | unset            | Codex runtime, Claude runtime, Git credential helper | User-facing/ops   | Shared secret sent to the GitHub token broker. Set with `GITHUB_TOKEN_BROKER_URL`. Without both settings, Phase 1a retains raw GitHub credentials for compatibility and logs a worker warning until #700. |
| `GITHUB_TOKEN_CACHE_PATH`        | unset            | Codex runtime, Claude runtime, Git credential helper | User-facing/ops   | Optional file path for caching brokered GitHub tokens.                                                                                                                                                    |
| `GITHUB_GIT_HOST`                | `github.com`     | Git credential helper                                | User-facing, GHES | Git host matched by the credential helper, for example `github.example`.                                                                                                                                  |
| `GITHUB_GIT_USERNAME`            | `x-access-token` | Git credential helper                                | User-facing       | Username emitted by the credential helper for HTTPS Git auth.                                                                                                                                             |
| `AGENT_CREDENTIAL_BROKER_URL`    | unset            | Codex runtime, Claude preflight/runtime              | User-facing/ops   | Broker endpoint for agent provider credentials such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.                                                                                                           |
| `AGENT_CREDENTIAL_BROKER_SECRET` | unset            | Codex runtime, Claude preflight/runtime              | User-facing/ops   | Shared secret sent to the agent credential broker. Set with `AGENT_CREDENTIAL_BROKER_URL`.                                                                                                                |
| `AGENT_CREDENTIAL_CACHE_PATH`    | unset            | Codex runtime                                        | User-facing/ops   | Optional file path for caching brokered agent credentials.                                                                                                                                                |

## Agent Runtime Credentials

These variables are passed through to the selected agent runtime. The CLI also
uses them during setup and doctor checks where applicable.

| Variable            | Default | Read by                                    | Audience             | Notes                                                                                                      |
| ------------------- | ------- | ------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`    | unset   | Codex runtime                              | User-facing          | Direct Codex/OpenAI credential. A broker can provide this instead.                                         |
| `OPENAI_BASE_URL`   | unset   | Codex runtime                              | User-facing/advanced | Optional OpenAI-compatible endpoint override passed to Codex.                                              |
| `OPENAI_ORG_ID`     | unset   | Codex runtime                              | User-facing/advanced | Optional OpenAI organization value passed to Codex.                                                        |
| `OPENAI_PROJECT`    | unset   | Codex runtime                              | User-facing/advanced | Optional OpenAI project value passed to Codex.                                                             |
| `ANTHROPIC_API_KEY` | unset   | CLI setup/doctor, Claude preflight/runtime | User-facing          | Direct Claude credential. Required for bare Claude runtimes unless an agent credential broker supplies it. |
| `CODEX_HOME`        | unset   | Codex runtime launcher                     | User-facing/advanced | Passed through to Codex only when set. Useful for isolating Codex config in containers or CI.              |

## CLI And Repository Runtime

These variables affect the local `gh-symphony` process or repository runtime
layout.

| Variable                               | Default                                                                                       | Read by                       | Audience           | Notes                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GH_SYMPHONY_CONFIG_DIR`               | CLI default config directory; official container sets `/var/lib/gh-symphony`                  | CLI                           | User-facing/ops    | Overrides the global runtime config directory. `--config <dir>` takes precedence. It also selects the explicit global `instances/` registry namespace; `--config` alone never splits that index. |
| `GH_SYMPHONY_INSTANCES_DIR`            | `${GH_SYMPHONY_CONFIG_DIR:-~/.gh-symphony}/instances`                                         | CLI daemon + `instances`      | User-facing/ops    | Host-global instance registry namespace. Captured before a `--config` runtime override and inherited by daemon children.                                                                         |
| `GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH` | unset                                                                                         | CLI `repo init`               | Internal/E2E       | Required only when binding the file tracker to a mounted issues fixture. Not needed for GitHub or Linear trackers.                                                                               |
| `GH_SYMPHONY_HTTP_TOKEN`               | random per `repo start` process                                                               | CLI HTTP servers              | User-facing/ops    | Shared bearer secret for all `/api/v1/*` routes. Set this for scripts, daemon clients, or a stable dashboard URL.                                                                                |
| `SYMPHONY_EVENTS_DIR`                  | runtime-managed event storage                                                                 | Orchestrator package CLI      | User-facing/ops    | Optional override for where orchestrator events are written.                                                                                                                                     |
| `SYMPHONY_LOG_LEVEL`                   | `normal`                                                                                      | CLI, orchestrator package CLI | User-facing/ops    | Supports `normal` and `verbose`. CLI flags override the env value.                                                                                                                               |
| `SYMPHONY_WORKER_COMMAND`              | auto-resolved `@gh-symphony/worker`, bundled worker entry, then `gh-symphony-worker` fallback | Orchestrator                  | User-facing/ops    | Shell command used to start worker processes. Useful for local E2E, debugging, or custom worker wrappers.                                                                                        |
| `SYMPHONY_E2E_PROJECT`                 | `symphony-e2e-<worktree-path-hash>`                                                           | Docker E2E runner scripts     | Internal/E2E       | Optional Compose project-name override. The runner derives a stable name from the current worktree and uses it for isolated containers, networks, volumes, and image tags.                       |
| `NO_COLOR`                             | unset                                                                                         | CLI                           | User-facing        | Set indirectly by `--no-color`; honored by terminal output rendering.                                                                                                                            |
| `EDITOR` / `VISUAL`                    | `vi` fallback                                                                                 | CLI `config edit`             | User-facing        | Selects the editor for interactive config editing.                                                                                                                                               |
| `PATH` / `PATHEXT`                     | inherited from shell                                                                          | CLI doctor, child processes   | User-facing/system | Used for prerequisite and command discovery.                                                                                                                                                     |

## Tuning Knobs

Prefer `WORKFLOW.md` runtime and agent settings for committed policy. These
environment variables are useful for host-level overrides or are injected from
workflow config into the worker.

| Variable                           | Default                                          | Read by                             | Audience          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYMPHONY_MAX_NONPRODUCTIVE_TURNS` | `3`                                              | Orchestrator, worker, Codex runtime | User-facing/ops   | Maximum consecutive turns without local workspace/HEAD progress before convergence handling. Canonical tracker state is read before each turn after the first and again at the threshold; a confirmed state outside the workflow's active states completes the run, while active/unconfirmed reads fail closed. These reads may consume live provider requests. Comments, PR pushes, and active-to-active transitions do not reset this counter. |
| `SYMPHONY_CONVERGENCE_LOCK_TTL_MS` | `86400000`                                       | Orchestrator                        | User-facing/ops   | Maximum age of a convergence lock before it is released and a `convergence-lock-expired` event is recorded.                                                                                                                                                                                                                                                                                                                                      |
| `SYMPHONY_READ_TIMEOUT_MS`         | `5000`                                           | Worker                              | Internal/injected | JSON-RPC read timeout for Codex app-server protocol. Sourced from `runtime.timeouts.read_timeout_ms` or legacy `codex.read_timeout_ms`.                                                                                                                                                                                                                                                                                                          |
| `SYMPHONY_TURN_TIMEOUT_MS`         | `3600000`                                        | Worker                              | Internal/injected | Per-turn timeout for Codex app-server protocol. Sourced from `runtime.timeouts.turn_timeout_ms` or legacy `codex.turn_timeout_ms`.                                                                                                                                                                                                                                                                                                               |
| `SYMPHONY_MAX_TURNS`               | `20` from workflow defaults                      | Worker                              | Internal/injected | Maximum turns for one worker session. Configure through `WORKFLOW.md` agent settings.                                                                                                                                                                                                                                                                                                                                                            |
| `SYMPHONY_APPROVAL_POLICY`         | `never` in worker policy resolution              | Worker                              | Internal/injected | Codex approval policy. Configure through `WORKFLOW.md`; injected into workers.                                                                                                                                                                                                                                                                                                                                                                   |
| `SYMPHONY_THREAD_SANDBOX`          | `danger-full-access` in worker policy resolution | Worker                              | Internal/injected | Codex thread sandbox. Configure through `WORKFLOW.md`; injected into workers.                                                                                                                                                                                                                                                                                                                                                                    |
| `SYMPHONY_TURN_SANDBOX_POLICY`     | unset                                            | Worker                              | Internal/injected | Optional per-turn sandbox policy. Configure through `WORKFLOW.md`; injected into workers.                                                                                                                                                                                                                                                                                                                                                        |
| `SYMPHONY_AGENT_COMMAND`           | workflow runtime command                         | Codex runtime launcher              | Internal/injected | Shell command used by the runtime launcher. Configure through `WORKFLOW.md` instead of setting directly.                                                                                                                                                                                                                                                                                                                                         |

## Worker Context Variables

The orchestrator injects these into worker processes. They are documented for
debugging, custom worker wrappers, and hook authors; operators usually should
not set them manually.

| Variable                          | Default                                   | Read by                                       | Audience          | Notes                                                                                   |
| --------------------------------- | ----------------------------------------- | --------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `PROJECT_ID` / `CODEX_PROJECT_ID` | active project ID                         | Codex runtime launcher                        | Internal/injected | Runtime project identity. One of these is required when running the launcher directly.  |
| `WORKING_DIRECTORY`               | issue repository checkout path            | Worker, Codex runtime launcher                | Internal/injected | Worker cwd / repository workspace path. Required when running a launcher directly.      |
| `WORKSPACE_RUNTIME_DIR`           | issue runtime directory                   | Worker, Codex runtime, Claude runtime         | Internal/injected | Stores worker runtime artifacts such as token usage and MCP config.                     |
| `SYMPHONY_RENDERED_PROMPT`        | rendered issue prompt                     | Worker                                        | Internal/injected | Prompt sent to the agent runtime.                                                       |
| `SYMPHONY_RUN_ID`                 | current run ID                            | Worker, hooks                                 | Internal/injected | Unique run identifier.                                                                  |
| `SYMPHONY_ORCHESTRATOR_URL`       | internal worker API URL                   | Worker                                        | Internal/injected | Used for authenticated worker-state, turn-lease, and run-scoped tracker state requests. |
| `SYMPHONY_ORCHESTRATOR_TOKEN`     | process-random secret                     | Worker                                        | Internal/injected | Authenticates worker-only orchestrator API calls; never exposed through status APIs.    |
| `SYMPHONY_CONTINUATION_GUIDANCE`  | workflow continuation guidance            | Worker                                        | Internal/injected | Prompt guidance used on continuation turns.                                             |
| `SYMPHONY_TRACKER_ADAPTER`        | active tracker adapter                    | Worker                                        | Internal/injected | Tracker adapter name, for example `github-project`, `linear`, or `file`.                |
| `SYMPHONY_TRACKER_KIND`           | active tracker kind                       | Codex runtime, Claude runtime, worker routing | Internal/injected | Enables Linear tooling when set to `linear`.                                            |
| `SYMPHONY_TRACKER_BINDING_ID`     | tracker binding ID                        | Worker                                        | Internal/injected | Tracker binding metadata.                                                               |
| `SYMPHONY_TRACKER_ITEM_ID`        | tracker item ID                           | Worker                                        | Internal/injected | Tracker item metadata.                                                                  |
| `SYMPHONY_ISSUE_ID`               | tracker issue ID                          | Worker                                        | Internal/injected | Tracker-native issue identifier.                                                        |
| `SYMPHONY_ISSUE_IDENTIFIER`       | `owner/repo#number` or tracker equivalent | Worker, hooks                                 | Internal/injected | Human-readable issue identifier.                                                        |
| `SYMPHONY_ISSUE_TITLE`            | issue title                               | Worker                                        | Internal/injected | Used for turn titles and context.                                                       |
| `SYMPHONY_ISSUE_STATE`            | tracker state                             | Worker, hooks                                 | Internal/injected | Current tracker state at dispatch time.                                                 |
| `SYMPHONY_ISSUE_SUBJECT_ID`       | tracker subject ID                        | Worker, hooks                                 | Internal/injected | Subject ID used for tracker-specific mutations.                                         |
| `SYMPHONY_ISSUE_WORKSPACE_KEY`    | workspace key                             | Worker, hooks                                 | Internal/injected | Stable workspace key for the issue.                                                     |
| `SYMPHONY_WORKFLOW_PATH`          | workflow file path                        | Worker                                        | Internal/injected | Path to the resolved workflow policy file.                                              |
| `TARGET_REPOSITORY_CLONE_URL`     | target repo clone URL                     | Worker                                        | Internal/injected | Clone URL for the issue repository.                                                     |
| `TARGET_REPOSITORY_OWNER`         | target repo owner                         | Worker                                        | Internal/injected | Repository owner.                                                                       |
| `TARGET_REPOSITORY_NAME`          | target repo name                          | Worker                                        | Internal/injected | Repository name.                                                                        |
| `TARGET_REPOSITORY_URL`           | target repo URL                           | Worker                                        | Internal/injected | Browser URL for the repository.                                                         |

### GitHub tracker transition extension

GitHub Project state writes are a repository extension to upstream Symphony SPEC §11.5. Workers send issue-scoped intent to the internal orchestrator API; the orchestrator authorizes the current `SYMPHONY_RUN_ID`, uses its persisted canonical tracker item, serializes requests against the shared GraphQL budget, and confirms an exact-item readback.

For `transition-request`, the worker may also send an agent-authored `comment_body`. After and only after the response is `ok: true`, `outcome: confirmed`, and the exact requested target state, the orchestrator asks the tracker adapter to idempotently publish that body. The adapter returns the finalized GraphQL budget for the comment operation so the same rate-limit accounting and adaptive polling path includes comment history reads, mutations, and retries. A comment-write failure is recorded in the structured run event log and run snapshot without changing the confirmed transition result; an exact existing body is treated as unchanged.

This intentionally differs from the upstream spec's typical agent-tool ownership of tracker writes. The extension is limited to GitHub tracker integration and quota coordination; lifecycle policy remains in `WORKFLOW.md`, and Symphony core does not contain GitHub-specific mutation semantics.

The comment publication is an explicit §11.5 divergence and implements the upstream §18.2 recommended extension. The orchestrator owns transport, serialization, retry, and readback sequencing; `WORKFLOW.md` owns the comment body policy, while `packages/tracker-github` owns GitHub GraphQL mutation semantics.

The `In review` → `Land` move is a human-owned project-board transition that happens before the Land worker is dispatched. The worker must not synthesize a no-op `Land` → `Land` request or publish a duplicate comment for that external trigger; the orchestrator-owned publication guarantee applies to transitions requested through `/gh-project`.

## Hook Variables

Workspace hooks receive the merged project/process environment plus these
context variables:

| Variable                       | Default                  | Read by | Audience          | Notes                                   |
| ------------------------------ | ------------------------ | ------- | ----------------- | --------------------------------------- |
| `SYMPHONY_PROJECT_ID`          | active project ID        | Hooks   | Internal/injected | Orchestrator project ID.                |
| `SYMPHONY_ISSUE_WORKSPACE_KEY` | workspace key            | Hooks   | Internal/injected | Stable workspace key for the issue.     |
| `SYMPHONY_ISSUE_SUBJECT_ID`    | tracker subject ID       | Hooks   | Internal/injected | Tracker-specific subject ID.            |
| `SYMPHONY_ISSUE_IDENTIFIER`    | issue identifier         | Hooks   | Internal/injected | Example: `acme/platform#42`.            |
| `SYMPHONY_WORKSPACE_PATH`      | issue workspace root     | Hooks   | Internal/injected | Absolute path to the issue workspace.   |
| `SYMPHONY_REPOSITORY_PATH`     | repository checkout path | Hooks   | Internal/injected | Absolute path to the cloned repository. |
| `SYMPHONY_RUN_ID`              | current run ID           | Hooks   | Internal/injected | Absent for `after_create`.              |
| `SYMPHONY_ISSUE_STATE`         | tracker state            | Hooks   | Internal/injected | Absent for `after_create`.              |

## Recovery And Resume Context

These variables are internal worker context. The orchestrator clears legacy
budget/resume values on fresh worker sessions to prevent stale process-level
values from leaking into new runs.

| Variable                              | Default                       | Read by        | Audience          | Notes                                                     |
| ------------------------------------- | ----------------------------- | -------------- | ----------------- | --------------------------------------------------------- |
| `SYMPHONY_RECOVERY_KIND`              | unset                         | Worker         | Internal/injected | Recovery mode metadata.                                   |
| `SYMPHONY_RECOVERY_DIRTY_FILES`       | unset                         | Worker         | Internal/injected | Dirty file summary for recovery prompts.                  |
| `SYMPHONY_RECOVERY_SUGGESTED_COMMAND` | unset                         | Worker         | Internal/injected | Suggested recovery command.                               |
| `SYMPHONY_SESSION_STARTED_AT`         | unset on fresh worker start   | Worker/runtime | Internal          | Reserved session metadata.                                |
| `SYMPHONY_GLOBAL_MAX_TURNS`           | cleared on fresh worker start | Worker/runtime | Legacy internal   | Legacy budget context.                                    |
| `SYMPHONY_MAX_TOKENS`                 | cleared on fresh worker start | Worker/runtime | Legacy internal   | Legacy token budget context.                              |
| `SYMPHONY_SESSION_TIMEOUT_MS`         | cleared on fresh worker start | Worker/runtime | Legacy internal   | Legacy session timeout context.                           |
| `SYMPHONY_RESUME_THREAD_ID`           | cleared on fresh worker start | Worker/runtime | Legacy internal   | Resume thread ID.                                         |
| `SYMPHONY_CUMULATIVE_TURN_COUNT`      | `0` on fresh worker start     | Worker/runtime | Internal          | Cumulative turn counter.                                  |
| `SYMPHONY_CUMULATIVE_INPUT_TOKENS`    | `0` on fresh worker start     | Worker/runtime | Internal          | Cumulative input tokens.                                  |
| `SYMPHONY_CUMULATIVE_OUTPUT_TOKENS`   | `0` on fresh worker start     | Worker/runtime | Internal          | Cumulative output tokens.                                 |
| `SYMPHONY_CUMULATIVE_TOTAL_TOKENS`    | `0` on fresh worker start     | Worker/runtime | Internal          | Cumulative total tokens.                                  |
| `SYMPHONY_LAST_TURN_SUMMARY`          | cleared on fresh worker start | Worker/runtime | Internal          | Last turn summary used for continuation/recovery context. |

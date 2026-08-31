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

### Tracker provider binding and live reload

`repo init` writes the runtime's selected tracker adapter and repository/project
binding to `config.json` and its project record. Changing that binding — for
example, switching `tracker.kind`, moving to a different initialized project,
or changing a runtime-owned provider path — requires running `gh-symphony repo
init` again and restarting the daemon. A `WORKFLOW.md` edit never rewrites
`config.json`.

The workflow policy passed to the already-selected adapter is live-reloaded on
every reconciliation tick: core `tracker.active_states`,
`tracker.terminal_states`, `tracker.state_field`, and the provider-owned
`blocker_check_states` and `planning_states` apply on the next tick. The
remaining provider settings — `project_id` or `project_slug`, `endpoint`,
`priority`, `priority_field_name`, and `pickup_labels` — are read from the
project record that `repo init` wrote, so editing them in `WORKFLOW.md` has no
effect until the runtime is initialized again and the daemon restarts. Existing
workers keep the policy and tracker dependencies captured for their own run.
This is the same tick-based reload boundary described above, not a
watcher-driven update.

## Runtime, Retry, and Hook Divergences

`codex.command` is tokenized and must resolve to the `codex` executable. This
repository does not invoke it through `bash -lc`; shell syntax, expansions, and
arbitrary executables are rejected as an intentional command-execution
divergence.

`agent.max_failure_retries` is the failed-attempt budget, including the
initial failed run: once the counter reaches this value, the issue is
suppressed rather than scheduling another retry. `agent.retry_base_delay_ms`
is the initial retry delay; later delays use exponential backoff bounded by
`agent.max_retry_backoff_ms`.

`codex.stall_timeout_ms` detects inactivity when positive. When it is zero or
negative, that threshold is disabled, but the orchestrator still applies a hard
30-minute elapsed-run fallback to prevent an indefinitely stuck worker. This is
an intentional implementation-defined safety limit.

Hooks are opt-in repository-local extensions, not shell snippets. Each hook
value must be a path to an executable script; shell syntax and inline commands
are rejected. Set `SYMPHONY_ALLOW_WORKFLOW_HOOKS=1` (or `true`) in the host
environment to permit hook execution. The gate and path-only rule intentionally
diverge from the upstream shell-command hook model.

## WORKFLOW.md Front-matter Validation

`gh-symphony workflow validate` and `gh-symphony doctor` use the same
strict parser as workflow loading. Failures include a stable error code; the
`workflow validate --json` error also exposes its field path separately.

| Rule                      | Required value                                                                                                                     | Error code/path                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Front matter syntax       | Optional; when present it must be a valid YAML mapping                                                                             | `workflow_parse_error` or `workflow_front_matter_not_a_map` at `front_matter`                       |
| Numeric fields            | YAML integers; quoted numeric strings and fractions are rejected. Invalid per-state concurrency entries are ignored with warnings. | `workflow_validation_error` at other invalid numeric field paths; warnings name ignored entry paths |
| `hooks.timeout_ms`        | A positive integer when provided                                                                                                   | `workflow_validation_error` at `hooks.timeout_ms`                                                   |
| `agent.max_turns`         | A positive integer when provided                                                                                                   | `workflow_validation_error` at `agent.max_turns`                                                    |
| `codex.command`           | A non-empty string when provided                                                                                                   | `workflow_validation_error` at `codex.command`                                                      |
| `tracker.kind`            | One of `github-project`, `linear`, or `file`                                                                                       | `workflow_validation_error` at `tracker.kind`                                                       |
| `tracker.required_labels` | An array of strings; comma-separated strings are rejected                                                                          | `workflow_validation_error` at `tracker.required_labels`                                            |
| `server.port`             | An integer from `0` to `65535`; `0` requests an ephemeral local port                                                               | `workflow_validation_error` at `server.port`                                                        |

Without front matter, the complete trimmed file is used as the workflow prompt
and all configuration uses defaults; tracker selection is then checked by the
dispatch preflight. `workspace.root` expands `~`, `$VAR`, `${VAR}`, and
`env:VAR`, resolves relative paths from the selected `WORKFLOW.md` directory,
and stores the normalized absolute path. Tracker configuration values (including
provider values) resolve documented environment references before adapter
validation; hook scripts and Codex/runtime command strings remain unchanged. A
missing or empty referenced secret returns a typed error at that specific field
rather than rewriting unrelated configuration.

Omitted optional values retain their documented defaults. Per-state concurrency
maps remain supported through `agent.max_concurrent_agents_by_state`. State keys
are trimmed and lowercased before storage and dispatch lookup, so for example
`" In Progress "` and `in progress` configure the same limit. Entries whose
values are non-positive or not YAML integers are ignored; valid entries in the
same map remain effective. `gh-symphony workflow validate` and `gh-symphony
doctor` warn with the ignored entry path and reason so the configuration
can be corrected without changing dispatch behavior.

## Optional HTTP Server

Set `server.port` in `WORKFLOW.md` to enable the HTTP status API on that port.
`0` requests an ephemeral port. `gh-symphony repo start --port [port]` is the
preferred CLI form and overrides `server.port`; `--http [port]` remains a
supported alias. A configured or explicit CLI port fails startup when it is
already occupied. A bare `--port` or `--http` keeps the legacy default-port
auto-increment behavior, while omitting both options and `server.port` uses an
ephemeral internal listener.

`tracker.required_labels` defaults to `[]`. It is an ALL-of routability gate:
labels are compared after trimming and lowercasing, and every configured label
must be present before an issue can be routed. A blank configured label is
preserved and therefore matches no issue. Removing a required label blocks new
dispatches and due retries; a worker also stops before its next turn when its
authenticated tracker-state read returns a refreshed, non-routable snapshot.
Reconciliation still terminates an active worker on its next tick without
workspace cleanup so its work remains available for recovery.

`tracker.provider.pickup_labels.include` is separate from
`tracker.required_labels`. For GitHub and Linear it is an ANY-of candidate
pre-filter: an issue needs at least one include label to enter the dispatch
candidate set. `exclude` always wins. Pickup-label changes affect future
candidate listing only; they do not make an already-running issue non-routable
or stop its worker. Use `required_labels` when the label must remain true
throughout a run.

## Label and Timestamp Normalization

Core normalizes workflow pickup labels and tracker-provided labels before label
matching: it trims surrounding whitespace, lowercases values, drops blanks, and
deduplicates while keeping the first occurrence. Thus `" Agent "`, `"agent"`,
and `"AGENT"` are the same label. `tracker.required_labels` deliberately uses
a separate normalization path: it retains blank configured labels so they match
no issue, as required by Symphony specification §5.3.1.

`parseTrackerTimestamp` accepts RFC 3339 timestamps, including lowercase `t` /
`z` designators and leap seconds, and returns a canonical ISO 8601 UTC string;
malformed values return `null`. It is intentionally a core
utility only in this change: tracker-adapter adoption is deferred, so existing
adapter behavior is unchanged.

For dispatch priority, see [ADR 2026-08-28](adr/2026-08-28_priority-mapping-documented-different-mapping.md).
The repository intentionally keeps numeric priorities, including non-integers,
in ascending order and places `null` last, a documented different mapping under
Symphony specification §8.2 and §11.3. Linear priority `0` currently passes
through the adapter and sorts before positive values; normalization to `null`
is pending adapter work in #660-B.

## Workflow Lifecycle Policy

`tracker.provider.blocker_check_states` selects the workflow states where the GitHub and
Linear adapters derive `dispatchable: false` from unresolved `blocked_by`
dependencies. The orchestrator consumes that normalized result and does not
interpret provider blocker semantics. When the field is omitted, the default is
`["Todo"]`, matching the Symphony candidate-selection rule. Set an explicit
empty list (`blocker_check_states: []`) only when adapter blocker derivation
should be disabled. This opt-out is an intentional repository-level divergence
from the vendored Symphony specification's unconditional blocker rule.

GitHub source-closed blockers and blockers whose Project workflow state is in
`tracker.terminal_states` are resolved. Linear uses its workflow-state relation
data directly. In both adapters, `blocked_by` remains best-effort metadata and
`dispatchReason` identifies an unresolved dependency. Omitting
`tracker.provider.planning_states` keeps planning disabled; blocker defaults do not enable the
planning/human-review execution phase. Linear `blocked_by` metadata is derived
from inverse relations of type `blocks`; source-side relations describe issues
blocked by the current issue and are not blockers of it.

## Linear and file tracker providers

Tracker-specific configuration belongs in `tracker.provider`. The former flat
keys remain deprecated, non-breaking aliases: `gh-symphony doctor` renders the
normalized provider block so operators can migrate without changing behavior.

```yaml
tracker:
  kind: linear
  provider:
    endpoint: https://api.linear.app/graphql # optional
    api_key: $LINEAR_API_KEY # optional environment reference
    project_slug: platform # required Linear project slug
    pickup_labels:
      include: [agent]
      exclude: [blocked]
```

Linear scopes polling with `project_slug`; it does not accept `project_id`,
`projectId`, `teamId`, or `team_id` as aliases. When provided, `api_key` must
be an environment reference so secrets remain outside committed workflow policy;
when omitted, the runtime uses `LINEAR_API_KEY`. Its documented
lifecycle default is `Todo`/`In Progress` active, `Done` terminal, `Todo`
blocker-check, and no planning states.

```yaml
tracker:
  kind: file
  provider:
    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: e2e-test
```

The file adapter is for local and Docker E2E fixtures. `provider.path` is the
required JSON fixture path unless `GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH` is set
as the documented compatibility fallback; its defaults are `Ready`/`In Progress` active,
`Done`/`Cancelled` terminal, `Ready` blocker-check, and no planning states.

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
`tracker.provider.planning_states` classifies states for prompt policy and status
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

### GitHub Project provider profile

For `tracker.kind: github-project`, configure GitHub-specific settings in
`tracker.provider`. The adapter owns `project_id`, `endpoint`, `state_field`,
`priority`, `pickup_labels`, `blocker_check_states`, and `planning_states`.
Unknown provider keys are preserved so provider extensions remain forward
compatible. `project_id`, `endpoint`, and `state_field` are non-empty strings
when supplied; `endpoint` must be an HTTP(S) URL; state lists contain only
non-empty strings.

```yaml
tracker:
  kind: github-project
  provider:
    project_id: PVT_kwDOxxxxxx
    endpoint: https://api.github.com/graphql
    state_field: Status
    blocker_check_states: [Todo]
    planning_states: []
    pickup_labels:
      include: [agent-ready]
      exclude: [blocked]
    priority:
      source: disabled
  active_states: [Todo, In Progress]
  terminal_states: [Done]
```

The documented GitHub Project lifecycle profile is `Status`, active states
`Todo` and `In Progress`, terminal state `Done`, blocker-check state `Todo`,
and no planning states. These defaults apply only when the corresponding list
or field is omitted. Flat `tracker.project_id`, `tracker.endpoint`,
`tracker.state_field`, `tracker.priority`, `tracker.pickup_labels`,
`tracker.blocker_check_states`, and `tracker.planning_states` aliases remain
supported for compatibility, but `gh-symphony workflow validate` and
`gh-symphony doctor` warn and print a copyable `tracker.provider` block.
They are scheduled for removal in the next major release; see
[ADR 2026-08-29](adr/2026-08-29_tracker-provider-alias-deprecation.md).

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

| Variable                 | Default                                                                                                          | Read by                                                                | Audience                                            | Notes                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_GRAPHQL_TOKEN`   | unset                                                                                                            | CLI, orchestrator, GitHub tracker, worker host tools and Git transport | User-facing                                         | Token-only GitHub auth source. Requires `repo`, `read:org`, and `project` scopes. Never inherited by the coding-agent child.                          |
| `GITHUB_GRAPHQL_API_URL` | unset; GitHub tooling falls back to the public GitHub GraphQL endpoint unless tracker config injects an endpoint | CLI doctor, Codex runtime, Claude runtime                              | User-facing, GHES                                   | Process-level GraphQL endpoint override. For GHES, prefer `tracker.provider.endpoint` in `WORKFLOW.md`; if both are set, keep them identical.         |
| `GITHUB_PROJECT_ID`      | unset; injected from project config for workers                                                                  | Codex runtime, Claude runtime                                          | Internal unless running a runtime launcher manually | Passed to GitHub GraphQL tooling so agent tools can target the active Project.                                                                        |
| `LINEAR_API_KEY`         | unset                                                                                                            | CLI, Linear tracker, worker host tools                                 | User-facing for Linear tracker projects             | Required for Linear repo startup. Retained at the host boundary and never inherited by the coding-agent child.                                        |
| `LINEAR_AUTHORIZATION`   | unset                                                                                                            | Linear tracker, worker host tools                                      | Advanced                                            | Optional raw Linear authorization value for host-side Linear operations; it takes priority over `LINEAR_API_KEY` and is never inherited by the child. |
| `LINEAR_GRAPHQL_URL`     | `https://api.linear.app/graphql` when the Linear tool is enabled                                                 | Codex runtime, Claude runtime                                          | User-facing for Linear Enterprise/proxy setups      | Overrides the Linear GraphQL endpoint.                                                                                                                |

## Credential Brokers And Git Access

Use these when workers need short-lived credentials or when Git traffic must
target a non-`github.com` host.

| Variable                         | Default          | Read by                                 | Audience          | Notes                                                                                                                        |
| -------------------------------- | ---------------- | --------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN_BROKER_URL`        | unset            | Worker host tools and Git transport     | User-facing/ops   | Broker endpoint for GitHub tokens. The endpoint is host-only and is not inherited by coding-agent children.                  |
| `GITHUB_TOKEN_BROKER_SECRET`     | unset            | Worker host tools and Git transport     | User-facing/ops   | Shared secret sent to the GitHub token broker. It is declared as a tracker secret and removed from every coding-agent child. |
| `GITHUB_TOKEN_CACHE_PATH`        | unset            | Worker host tools and Git transport     | User-facing/ops   | Optional host-side file path for caching brokered GitHub tokens.                                                             |
| `GITHUB_GIT_HOST`                | `github.com`     | Git credential helper                   | User-facing, GHES | Git host matched by the credential helper, for example `github.example`.                                                     |
| `GITHUB_GIT_USERNAME`            | `x-access-token` | Git credential helper                   | User-facing       | Username emitted by the credential helper for HTTPS Git auth.                                                                |
| `AGENT_CREDENTIAL_BROKER_URL`    | unset            | Codex runtime, Claude preflight/runtime | User-facing/ops   | Broker endpoint for agent provider credentials such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.                              |
| `AGENT_CREDENTIAL_BROKER_SECRET` | unset            | Codex runtime, Claude preflight/runtime | User-facing/ops   | Shared secret sent to the agent credential broker. Set with `AGENT_CREDENTIAL_BROKER_URL`.                                   |
| `AGENT_CREDENTIAL_CACHE_PATH`    | unset            | Codex runtime                           | User-facing/ops   | Optional file path for caching brokered agent credentials.                                                                   |

## Agent Runtime Credentials

These variables are passed through to the selected agent runtime. The CLI also
uses them during setup and doctor checks where applicable.

| Variable            | Default | Read by                                    | Audience             | Notes                                                                                                                                    |
| ------------------- | ------- | ------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`    | unset   | Codex runtime                              | User-facing          | Direct Codex/OpenAI credential. A broker can provide this instead.                                                                       |
| `OPENAI_BASE_URL`   | unset   | Codex runtime                              | User-facing/advanced | Optional OpenAI-compatible endpoint override passed to Codex.                                                                            |
| `OPENAI_ORG_ID`     | unset   | Codex runtime                              | User-facing/advanced | Optional OpenAI organization value passed to Codex.                                                                                      |
| `OPENAI_PROJECT`    | unset   | Codex runtime                              | User-facing/advanced | Optional OpenAI project value passed to Codex.                                                                                           |
| `ANTHROPIC_API_KEY` | unset   | CLI setup/doctor, Claude preflight/runtime | User-facing          | Direct Claude credential. Required for bare Claude runtimes unless an agent credential broker supplies it.                               |
| `CODEX_HOME`        | unset   | Codex runtime launcher                     | User-facing/advanced | Host-side source for Codex `auth.json`. The child always receives a workspace-contained `CODEX_HOME`; host configuration is not exposed. |

When a direct provider API key is absent, non-bare runtimes copy only the
provider login needed by the selected agent into the private child home. Codex
stages `auth.json`; Claude stages only `claudeAiOauth` from
`.claude/.credentials.json` and excludes `mcpOAuth`. The child `HOME`,
`CODEX_HOME`, and `GH_CONFIG_DIR` stay inside the workspace runtime directory,
with no host `gh` configuration or tracker credential files.

## CLI And Repository Runtime

These variables affect the local `gh-symphony` process or repository runtime
layout.

| Variable                               | Default                                                                                       | Read by                       | Audience           | Notes                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GH_SYMPHONY_CONFIG_DIR`               | CLI default config directory; official container sets `/var/lib/gh-symphony`                  | CLI                           | User-facing/ops    | Overrides the global runtime config directory. `--config <dir>` takes precedence. It also selects the explicit global `instances/` registry namespace; `--config` alone never splits that index.  |
| `GH_SYMPHONY_INSTANCES_DIR`            | `${GH_SYMPHONY_CONFIG_DIR:-~/.gh-symphony}/instances`                                         | CLI daemon + `instances`      | User-facing/ops    | Host-global instance registry namespace. Captured before a `--config` runtime override and inherited by daemon children.                                                                          |
| `GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH` | unset                                                                                         | CLI file tracker              | Internal/E2E       | Compatibility fallback for a file workflow without `tracker.provider.path`; provider paths may also use this variable or another environment reference. Not needed for GitHub or Linear trackers. |
| `GH_SYMPHONY_HTTP_TOKEN`               | random per `repo start` process                                                               | CLI HTTP servers              | User-facing/ops    | Shared bearer secret for all `/api/v1/*` routes. Set this for scripts, daemon clients, or a stable dashboard URL.                                                                                 |
| `SYMPHONY_EVENTS_DIR`                  | runtime-managed event storage                                                                 | Orchestrator package CLI      | User-facing/ops    | Optional override for where orchestrator events are written.                                                                                                                                      |
| `SYMPHONY_LOG_LEVEL`                   | `normal`                                                                                      | CLI, orchestrator package CLI | User-facing/ops    | Supports `normal` and `verbose`. CLI flags override the env value.                                                                                                                                |
| `SYMPHONY_WORKER_COMMAND`              | auto-resolved `@gh-symphony/worker`, bundled worker entry, then `gh-symphony-worker` fallback | Orchestrator                  | User-facing/ops    | Shell command used to start worker processes. Useful for local E2E, debugging, or custom worker wrappers.                                                                                         |
| `SYMPHONY_E2E_PROJECT`                 | `symphony-e2e-<worktree-path-hash>`                                                           | Docker E2E runner scripts     | Internal/E2E       | Optional Compose project-name override. The runner derives a stable name from the current worktree and uses it for isolated containers, networks, volumes, and image tags.                        |
| `NO_COLOR`                             | unset                                                                                         | CLI                           | User-facing        | Set indirectly by `--no-color`; honored by terminal output rendering.                                                                                                                             |
| `EDITOR` / `VISUAL`                    | `vi` fallback                                                                                 | CLI `config edit`             | User-facing        | Selects the editor for interactive config editing.                                                                                                                                                |
| `PATH` / `PATHEXT`                     | inherited from shell                                                                          | CLI doctor, child processes   | User-facing/system | Used for prerequisite and command discovery.                                                                                                                                                      |

## Tuning Knobs

Prefer `WORKFLOW.md` runtime and agent settings for committed policy. These
environment variables are useful for host-level overrides or are injected from
workflow config into the worker.

| Variable                           | Default                                          | Read by                             | Audience          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYMPHONY_MAX_NONPRODUCTIVE_TURNS` | `3`                                              | Orchestrator, worker, Codex runtime | User-facing/ops   | Maximum consecutive turns without local workspace/HEAD progress before convergence handling. Canonical tracker state is read before each turn after the first and again at the threshold; a confirmed state outside the workflow's active states completes the run, while active/unconfirmed reads fail closed. These reads may consume live provider requests. Comments, PR pushes, and active-to-active transitions do not reset this counter. |
| `SYMPHONY_CONVERGENCE_LOCK_TTL_MS` | `86400000`                                       | Orchestrator                        | User-facing/ops   | Maximum age of a convergence lock before it is released and a `convergence-lock-expired` event is recorded.                                                                                                                                                                                                                                                                                                                                      |
| `SYMPHONY_READ_TIMEOUT_MS`         | `5000`                                           | Worker                              | Internal/injected | JSON-RPC read timeout for Codex app-server. Claude print mode uses `stall_timeout_ms` for the slower initial CLI/MCP/first-output wait. Sourced from `runtime.timeouts.read_timeout_ms` or legacy `codex.read_timeout_ms`.                                                                                                                                                                                                                       |
| `SYMPHONY_TURN_TIMEOUT_MS`         | `3600000`                                        | Worker                              | Internal/injected | Maximum silence interval for the active turn: Codex app-server output and Claude print-mode stdout/stderr chunks each reset it. It does not cap total turn duration. The orchestrator reclaims inactive workers after 30 minutes, so values above that have an effective 30-minute ceiling. Sourced from `runtime.timeouts.turn_timeout_ms` or legacy `codex.turn_timeout_ms`.                                                                   |
| `SYMPHONY_MAX_TURNS`               | `20` from workflow defaults                      | Worker                              | Internal/injected | Maximum turns for one worker session, including Claude print-mode session-resumed continuation turns. Configure through `WORKFLOW.md` agent settings.                                                                                                                                                                                                                                                                                            |
| `SYMPHONY_APPROVAL_POLICY`         | `never` in worker policy resolution              | Worker                              | Internal/injected | Codex approval policy. Only `never` is supported: workflows using another value fail validation before a worker can issue an unhandled approval request.                                                                                                                                                                                                                                                                                         |
| `SYMPHONY_THREAD_SANDBOX`          | `danger-full-access` in worker policy resolution | Worker                              | Internal/injected | Codex thread sandbox. Configure through `WORKFLOW.md`; injected into workers.                                                                                                                                                                                                                                                                                                                                                                    |
| `SYMPHONY_TURN_SANDBOX_POLICY`     | unset                                            | Worker                              | Internal/injected | Optional per-turn sandbox policy. Configure through `WORKFLOW.md`; injected into workers.                                                                                                                                                                                                                                                                                                                                                        |
| `SYMPHONY_AGENT_COMMAND`           | workflow runtime command                         | Codex runtime launcher              | Internal/injected | Shell command used by the runtime launcher. Configure through `WORKFLOW.md` instead of setting directly.                                                                                                                                                                                                                                                                                                                                         |

## Worker Context Variables

The orchestrator injects these into worker processes. They are documented for
debugging, custom worker wrappers, and hook authors; operators usually should
not set them manually.

| Variable                          | Default                                   | Read by                                       | Audience          | Notes                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------- | --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_ID` / `CODEX_PROJECT_ID` | active project ID                         | Codex runtime launcher                        | Internal/injected | Runtime project identity. One of these is required when running the launcher directly.                                                                                                                                             |
| `WORKING_DIRECTORY`               | issue repository checkout path            | Worker, Codex runtime launcher                | Internal/injected | Worker cwd / repository workspace path. Required when running a launcher directly.                                                                                                                                                 |
| `SYMPHONY_ASSIGNED_BRANCH`        | orchestrator-captured checkout branch     | Worker host Git transport                     | Internal/injected | Immutable per-run push target captured before the coding-agent child starts. The host refuses to push when the child moves the worktree to another branch.                                                                         |
| `WORKSPACE_RUNTIME_DIR`           | issue runtime directory                   | Worker, Codex runtime, Claude runtime         | Internal/injected | Stores worker runtime artifacts such as token usage and MCP config. Claude's generated `mcp.json` uses a worker-owned loopback HTTP/SSE URL plus an ephemeral per-run session capability; it does not contain adapter credentials. |
| child `HOME` / `GH_CONFIG_DIR`    | `<WORKSPACE_RUNTIME_DIR>/child-home`      | Codex and Claude child processes              | Internal/injected | Isolates agent configuration from the operator's home, `gh auth` store, and global Git credential helpers.                                                                                                                         |
| `SYMPHONY_RENDERED_PROMPT`        | rendered issue prompt                     | Worker                                        | Internal/injected | Prompt sent to the agent runtime.                                                                                                                                                                                                  |
| `SYMPHONY_RUN_ID`                 | current run ID                            | Worker, hooks                                 | Internal/injected | Unique run identifier.                                                                                                                                                                                                             |
| `SYMPHONY_ORCHESTRATOR_URL`       | internal worker API URL                   | Worker                                        | Internal/injected | Used for authenticated worker-state, turn-lease, and run-scoped tracker state requests.                                                                                                                                            |
| `SYMPHONY_ORCHESTRATOR_TOKEN`     | process-random secret                     | Worker                                        | Internal/injected | Authenticates worker-only orchestrator API calls; never exposed through status APIs.                                                                                                                                               |
| `SYMPHONY_CONTINUATION_GUIDANCE`  | workflow continuation guidance            | Worker                                        | Internal/injected | Prompt guidance used on continuation turns.                                                                                                                                                                                        |
| `SYMPHONY_TRACKER_ADAPTER`        | active tracker adapter                    | Worker                                        | Internal/injected | Tracker adapter name, for example `github-project`, `linear`, or `file`.                                                                                                                                                           |
| `SYMPHONY_TRACKER_KIND`           | active tracker kind                       | Codex runtime, Claude runtime, worker routing | Internal/injected | Enables Linear tooling when set to `linear`.                                                                                                                                                                                       |
| `SYMPHONY_TRACKER_BINDING_ID`     | tracker binding ID                        | Worker                                        | Internal/injected | Tracker binding metadata.                                                                                                                                                                                                          |
| `SYMPHONY_TRACKER_ITEM_ID`        | tracker item ID                           | Worker                                        | Internal/injected | Tracker item metadata.                                                                                                                                                                                                             |
| `SYMPHONY_ISSUE_ID`               | tracker issue ID                          | Worker                                        | Internal/injected | Tracker-native issue identifier.                                                                                                                                                                                                   |
| `SYMPHONY_ISSUE_IDENTIFIER`       | `owner/repo#number` or tracker equivalent | Worker, hooks                                 | Internal/injected | Human-readable issue identifier.                                                                                                                                                                                                   |
| `SYMPHONY_ISSUE_TITLE`            | issue title                               | Worker                                        | Internal/injected | Used for turn titles and context.                                                                                                                                                                                                  |
| `SYMPHONY_ISSUE_STATE`            | tracker state                             | Worker, hooks                                 | Internal/injected | Current tracker state at dispatch time.                                                                                                                                                                                            |
| `SYMPHONY_ISSUE_SUBJECT_ID`       | tracker subject ID                        | Worker, hooks                                 | Internal/injected | Subject ID used for tracker-specific mutations.                                                                                                                                                                                    |
| `SYMPHONY_ISSUE_WORKSPACE_KEY`    | workspace key                             | Worker, hooks                                 | Internal/injected | Stable workspace key; sanitized identifiers add a 16-hex SHA-256 suffix.                                                                                                                                                           |
| `SYMPHONY_WORKFLOW_PATH`          | workflow file path                        | Worker                                        | Internal/injected | Path to the resolved workflow policy file.                                                                                                                                                                                         |
| `TARGET_REPOSITORY_CLONE_URL`     | target repo clone URL                     | Worker                                        | Internal/injected | Clone URL for the issue repository.                                                                                                                                                                                                |
| `TARGET_REPOSITORY_OWNER`         | target repo owner                         | Worker                                        | Internal/injected | Repository owner.                                                                                                                                                                                                                  |
| `TARGET_REPOSITORY_NAME`          | target repo name                          | Worker                                        | Internal/injected | Repository name.                                                                                                                                                                                                                   |
| `TARGET_REPOSITORY_URL`           | target repo URL                           | Worker                                        | Internal/injected | Browser URL for the repository.                                                                                                                                                                                                    |

### GitHub tracker transition extension

GitHub Project state writes are a repository extension to upstream Symphony SPEC §11.5. Workers send issue-scoped intent to the internal orchestrator API; the orchestrator authorizes the current `SYMPHONY_RUN_ID`, uses its persisted canonical tracker item, serializes requests against the shared GraphQL budget, and confirms an exact-item readback.

For `transition-request`, the worker may also send an agent-authored `comment_body`. After and only after the response is `ok: true`, `outcome: confirmed`, and the exact requested target state, the orchestrator asks the tracker adapter to idempotently publish that body. The adapter returns the finalized GraphQL budget for the comment operation so the same rate-limit accounting and adaptive polling path includes comment history reads, mutations, and retries. A comment-write failure is recorded in the structured run event log and run snapshot without changing the confirmed transition result; an exact existing body is treated as unchanged.

This intentionally differs from the upstream spec's typical agent-tool ownership of tracker writes. The extension is limited to GitHub tracker integration and quota coordination; lifecycle policy remains in `WORKFLOW.md`, and Symphony core does not contain GitHub-specific mutation semantics.

The comment publication is an explicit §11.5 divergence and implements the upstream §18.2 recommended extension. The orchestrator owns transport, serialization, retry, and readback sequencing; `WORKFLOW.md` owns the comment body policy, while `packages/tracker-github` owns GitHub GraphQL mutation semantics.

### Workspace-key migration

New issue workspaces preserve readable sanitized identifiers and append a stable
64-bit SHA-256 suffix whenever sanitization changes the identifier, for example
`acme/platform#42` becomes `acme_platform_42-cbb20472b0ece3db`. Existing
suffixless workspace directories are checked after the new key and are reused
in place; Symphony does not rename directories. `gh-symphony repo status` and
`repo explain` display `workspace key: legacy` when a suffixless directory is
being reused.

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

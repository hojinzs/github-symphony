# Configuration Reference

This page is the operator-facing reference for environment variables that
GitHub Symphony reads directly or injects into worker runtimes. Prefer
committed `WORKFLOW.md` settings for workflow policy, and use environment
variables for host-specific authentication, Enterprise endpoints, local paths,
and operational overrides.

## Environment Loading Order

Worker and hook environments are merged in this order, with later values taking
precedence:

| Priority | Source                           | Applies to                                        |
| -------- | -------------------------------- | ------------------------------------------------- |
| 1        | Project `.env` file              | Hooks and worker processes                        |
| 2        | Orchestrator process environment | CLI, orchestrator, worker, runtime adapters       |
| 3        | Symphony-injected context        | Worker identity, issue metadata, runtime settings |

The project `.env` file lives at
`~/.gh-symphony/projects/<project-id>/.env`, or
`<config-dir>/projects/<project-id>/.env` when `--config <dir>` or
`GH_SYMPHONY_CONFIG_DIR` selects another config directory.

## Auth And API Endpoints

These variables are user-facing and are safe to set in local shells, CI, or
container environments.

| Variable                 | Default                                                                                                          | Read by                                                                                 | Audience                                            | Notes                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_GRAPHQL_TOKEN`   | unset                                                                                                            | CLI, orchestrator, GitHub tracker, Codex runtime, Claude runtime, Git credential helper | User-facing                                         | Token-only GitHub auth source. Requires `repo`, `read:org`, and `project` scopes. Takes priority over `gh` CLI auth where both are supported. |
| `GITHUB_GRAPHQL_API_URL` | unset; GitHub tooling falls back to the public GitHub GraphQL endpoint unless tracker config injects an endpoint | CLI doctor, Codex runtime, Claude runtime                                               | User-facing, GHES                                   | Process-level GraphQL endpoint override. For GHES, prefer `tracker.endpoint` in `WORKFLOW.md`; if both are set, keep them identical.          |
| `GITHUB_PROJECT_ID`      | unset; injected from project config for workers                                                                  | Codex runtime, Claude runtime                                                           | Internal unless running a runtime launcher manually | Passed to GitHub GraphQL tooling so agent tools can target the active Project.                                                                |
| `LINEAR_API_KEY`         | unset                                                                                                            | CLI, Codex runtime, Claude preflight                                                    | User-facing for Linear tracker projects             | Required for Linear repo startup and injected into Linear tooling when available.                                                             |
| `LINEAR_AUTHORIZATION`   | unset                                                                                                            | Codex runtime                                                                           | Advanced                                            | Optional raw Linear authorization value for the Linear GraphQL tool.                                                                          |
| `LINEAR_GRAPHQL_URL`     | `https://api.linear.app/graphql` when the Linear tool is enabled                                                 | Codex runtime, Claude runtime                                                           | User-facing for Linear Enterprise/proxy setups      | Overrides the Linear GraphQL endpoint.                                                                                                        |

## Credential Brokers And Git Access

Use these when workers need short-lived credentials or when Git traffic must
target a non-`github.com` host.

| Variable                         | Default          | Read by                                              | Audience          | Notes                                                                                           |
| -------------------------------- | ---------------- | ---------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN_BROKER_URL`        | unset            | Codex runtime, Claude runtime, Git credential helper | User-facing/ops   | Broker endpoint for GitHub tokens used by GitHub GraphQL tooling and Git credential resolution. |
| `GITHUB_TOKEN_BROKER_SECRET`     | unset            | Codex runtime, Claude runtime, Git credential helper | User-facing/ops   | Shared secret sent to the GitHub token broker. Set with `GITHUB_TOKEN_BROKER_URL`.              |
| `GITHUB_TOKEN_CACHE_PATH`        | unset            | Codex runtime, Claude runtime, Git credential helper | User-facing/ops   | Optional file path for caching brokered GitHub tokens.                                          |
| `GITHUB_GIT_HOST`                | `github.com`     | Git credential helper                                | User-facing, GHES | Git host matched by the credential helper, for example `github.example`.                        |
| `GITHUB_GIT_USERNAME`            | `x-access-token` | Git credential helper                                | User-facing       | Username emitted by the credential helper for HTTPS Git auth.                                   |
| `AGENT_CREDENTIAL_BROKER_URL`    | unset            | Codex runtime, Claude preflight/runtime              | User-facing/ops   | Broker endpoint for agent provider credentials such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. |
| `AGENT_CREDENTIAL_BROKER_SECRET` | unset            | Codex runtime, Claude preflight/runtime              | User-facing/ops   | Shared secret sent to the agent credential broker. Set with `AGENT_CREDENTIAL_BROKER_URL`.      |
| `AGENT_CREDENTIAL_CACHE_PATH`    | unset            | Codex runtime                                        | User-facing/ops   | Optional file path for caching brokered agent credentials.                                      |

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

| Variable                               | Default                                                                                       | Read by                       | Audience           | Notes                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `GH_SYMPHONY_CONFIG_DIR`               | CLI default config directory; official container sets `/var/lib/gh-symphony`                  | CLI                           | User-facing/ops    | Overrides the global runtime config directory. `--config <dir>` takes precedence.                                  |
| `GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH` | unset                                                                                         | CLI `repo init`               | Internal/E2E       | Required only when binding the file tracker to a mounted issues fixture. Not needed for GitHub or Linear trackers. |
| `SYMPHONY_EVENTS_DIR`                  | runtime-managed event storage                                                                 | Orchestrator package CLI      | User-facing/ops    | Optional override for where orchestrator events are written.                                                       |
| `SYMPHONY_LOG_LEVEL`                   | `normal`                                                                                      | CLI, orchestrator package CLI | User-facing/ops    | Supports `normal` and `verbose`. CLI flags override the env value.                                                 |
| `SYMPHONY_WORKER_COMMAND`              | auto-resolved `@gh-symphony/worker`, bundled worker entry, then `gh-symphony-worker` fallback | Orchestrator                  | User-facing/ops    | Shell command used to start worker processes. Useful for local E2E, debugging, or custom worker wrappers.          |
| `NO_COLOR`                             | unset                                                                                         | CLI                           | User-facing        | Set indirectly by `--no-color`; honored by terminal output rendering.                                              |
| `EDITOR` / `VISUAL`                    | `vi` fallback                                                                                 | CLI `config edit`             | User-facing        | Selects the editor for interactive config editing.                                                                 |
| `PATH` / `PATHEXT`                     | inherited from shell                                                                          | CLI doctor, child processes   | User-facing/system | Used for prerequisite and command discovery.                                                                       |

## Tuning Knobs

Prefer `WORKFLOW.md` runtime and agent settings for committed policy. These
environment variables are useful for host-level overrides or are injected from
workflow config into the worker.

| Variable                           | Default                                          | Read by                             | Audience          | Notes                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `SYMPHONY_MAX_NONPRODUCTIVE_TURNS` | `3`                                              | Orchestrator, worker, Codex runtime | User-facing/ops   | Maximum consecutive turns without detected progress before convergence handling. The orchestrator injects this into workers.            |
| `SYMPHONY_READ_TIMEOUT_MS`         | `5000`                                           | Worker                              | Internal/injected | JSON-RPC read timeout for Codex app-server protocol. Sourced from `runtime.timeouts.read_timeout_ms` or legacy `codex.read_timeout_ms`. |
| `SYMPHONY_TURN_TIMEOUT_MS`         | `3600000`                                        | Worker                              | Internal/injected | Per-turn timeout for Codex app-server protocol. Sourced from `runtime.timeouts.turn_timeout_ms` or legacy `codex.turn_timeout_ms`.      |
| `SYMPHONY_MAX_TURNS`               | `20` from workflow defaults                      | Worker                              | Internal/injected | Maximum turns for one worker session. Configure through `WORKFLOW.md` agent settings.                                                   |
| `SYMPHONY_APPROVAL_POLICY`         | `never` in worker policy resolution              | Worker                              | Internal/injected | Codex approval policy. Configure through `WORKFLOW.md`; injected into workers.                                                          |
| `SYMPHONY_THREAD_SANDBOX`          | `danger-full-access` in worker policy resolution | Worker                              | Internal/injected | Codex thread sandbox. Configure through `WORKFLOW.md`; injected into workers.                                                           |
| `SYMPHONY_TURN_SANDBOX_POLICY`     | unset                                            | Worker                              | Internal/injected | Optional per-turn sandbox policy. Configure through `WORKFLOW.md`; injected into workers.                                               |
| `SYMPHONY_AGENT_COMMAND`           | workflow runtime command                         | Codex runtime launcher              | Internal/injected | Shell command used by the runtime launcher. Configure through `WORKFLOW.md` instead of setting directly.                                |

## Worker Context Variables

The orchestrator injects these into worker processes. They are documented for
debugging, custom worker wrappers, and hook authors; operators usually should
not set them manually.

| Variable                          | Default                                   | Read by                                       | Audience          | Notes                                                                                  |
| --------------------------------- | ----------------------------------------- | --------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| `PROJECT_ID` / `CODEX_PROJECT_ID` | active project ID                         | Codex runtime launcher                        | Internal/injected | Runtime project identity. One of these is required when running the launcher directly. |
| `WORKING_DIRECTORY`               | issue repository checkout path            | Worker, Codex runtime launcher                | Internal/injected | Worker cwd / repository workspace path. Required when running a launcher directly.     |
| `WORKSPACE_RUNTIME_DIR`           | issue runtime directory                   | Worker, Codex runtime, Claude runtime         | Internal/injected | Stores worker runtime artifacts such as token usage and MCP config.                    |
| `SYMPHONY_RENDERED_PROMPT`        | rendered issue prompt                     | Worker                                        | Internal/injected | Prompt sent to the agent runtime.                                                      |
| `SYMPHONY_RUN_ID`                 | current run ID                            | Worker, hooks                                 | Internal/injected | Unique run identifier.                                                                 |
| `SYMPHONY_ORCHESTRATOR_URL`       | unset unless status API is available      | Worker                                        | Internal/injected | Used by workers to refresh tracker state through `/api/v1/state`.                      |
| `SYMPHONY_CONTINUATION_GUIDANCE`  | workflow continuation guidance            | Worker                                        | Internal/injected | Prompt guidance used on continuation turns.                                            |
| `SYMPHONY_TRACKER_ADAPTER`        | active tracker adapter                    | Worker                                        | Internal/injected | Tracker adapter name, for example `github-project`, `linear`, or `file`.               |
| `SYMPHONY_TRACKER_KIND`           | active tracker kind                       | Codex runtime, Claude runtime, worker routing | Internal/injected | Enables Linear tooling when set to `linear`.                                           |
| `SYMPHONY_TRACKER_BINDING_ID`     | tracker binding ID                        | Worker                                        | Internal/injected | Tracker binding metadata.                                                              |
| `SYMPHONY_TRACKER_ITEM_ID`        | tracker item ID                           | Worker                                        | Internal/injected | Tracker item metadata.                                                                 |
| `SYMPHONY_ISSUE_ID`               | tracker issue ID                          | Worker                                        | Internal/injected | Tracker-native issue identifier.                                                       |
| `SYMPHONY_ISSUE_IDENTIFIER`       | `owner/repo#number` or tracker equivalent | Worker, hooks                                 | Internal/injected | Human-readable issue identifier.                                                       |
| `SYMPHONY_ISSUE_TITLE`            | issue title                               | Worker                                        | Internal/injected | Used for turn titles and context.                                                      |
| `SYMPHONY_ISSUE_STATE`            | tracker state                             | Worker, hooks                                 | Internal/injected | Current tracker state at dispatch time.                                                |
| `SYMPHONY_ISSUE_SUBJECT_ID`       | tracker subject ID                        | Worker, hooks                                 | Internal/injected | Subject ID used for tracker-specific mutations.                                        |
| `SYMPHONY_ISSUE_WORKSPACE_KEY`    | workspace key                             | Worker, hooks                                 | Internal/injected | Stable workspace key for the issue.                                                    |
| `SYMPHONY_WORKFLOW_PATH`          | workflow file path                        | Worker                                        | Internal/injected | Path to the resolved workflow policy file.                                             |
| `TARGET_REPOSITORY_CLONE_URL`     | target repo clone URL                     | Worker                                        | Internal/injected | Clone URL for the issue repository.                                                    |
| `TARGET_REPOSITORY_OWNER`         | target repo owner                         | Worker                                        | Internal/injected | Repository owner.                                                                      |
| `TARGET_REPOSITORY_NAME`          | target repo name                          | Worker                                        | Internal/injected | Repository name.                                                                       |
| `TARGET_REPOSITORY_URL`           | target repo URL                           | Worker                                        | Internal/injected | Browser URL for the repository.                                                        |

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

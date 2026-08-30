# File adapter profile

This compact §11.2 profile documents the `file` adapter used by local and
Docker E2E environments. It is intentionally a fixture adapter, not a
production tracker provider.

## Configuration and scope

| Item           | Contract                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker.kind` | `file`                                                                                                                                                                    |
| Provider scope | A local JSON issue array selected by the adapter's configured issues path; it has no project, board, team, or remote repository selection.                                |
| Provider keys  | `tracker.provider.path` is validated when present; the normalized runtime setting supplies the required issues path. Unknown provider keys are preserved by core parsing. |
| Defaults       | Lifecycle defaults are `Status`, active `Ready`/`In Progress`, terminal `Done`/`Cancelled`, blocker checks in `Ready`, and no planning states.                            |
| Credentials    | `secretEnvironmentNames()` is empty: file fixtures require no secret or environment variable.                                                                             |
| Validation     | A supplied `path` must be a non-empty string; a missing runtime issues path is an invalid adapter configuration.                                                          |

There is no provider request pagination, page size, timeout, or rate limit: the
adapter reads one local JSON file per operation. A missing file yields an empty
candidate list. An unreadable file, malformed JSON, or a top-level non-array is
a file/response failure rather than a silent partial read.

## Normalized issue contract

| Field or condition                  | File mapping                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` and `native_ref`               | Fixture `id` is retained unchanged. `native_ref` is retained when supplied, otherwise it defaults to `{ itemId: tracker.itemId }`.                                                                                      |
| State, labels, priority, timestamps | Valid fixture values are preserved; fixture authors supply their normalized form. The adapter does not invent provider-specific state, label, priority, or timestamp mappings.                                          |
| `dispatchable`                      | An omitted value defaults to `true`; `false` and `dispatchReason` can be supplied to exercise the adapter-neutral scheduler gate. Pickup-label filtering remains available through the shared normalized filter.        |
| Malformed and optional fields       | Entries lacking required shape (`id`, `identifier`, `state`, object `repository`, object `tracker`, or a boolean `dispatchable` when supplied) are skipped with a diagnostic. Optional `assigneeId` defaults to `null`. |

## Native tools and errors

The file adapter exposes no provider-native agent tool.

| Provider-native failure                                | Adapter category                          |
| ------------------------------------------------------ | ----------------------------------------- |
| File read failure or invalid JSON payload              | `tracker_request` / `tracker_response`    |
| No corresponding provider HTTP status                  | `tracker_status` (not applicable)         |
| No pagination                                          | `tracker_pagination` (not applicable)     |
| No remote quota                                        | `tracker_rate_limited` (not applicable)   |
| Invalid `path` or missing required issues-path setting | `invalid_tracker_config`                  |
| No credentials required                                | `missing_tracker_secret` (not applicable) |

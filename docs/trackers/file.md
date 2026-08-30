# File adapter profile

This compact §11.2 profile documents the `file` adapter used by local and
Docker E2E environments. It is intentionally a fixture adapter, not a
production tracker provider.

## Configuration and scope

| Item           | Contract                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker.kind` | `file`                                                                                                                                                                                                                     |
| Provider scope | A local JSON issue array selected by `tracker.settings.issuesPath`; it has no project, board, team, or remote repository selection.                                                                                        |
| Provider keys  | `tracker.provider.path` is accepted and validated for forward compatibility but is currently inert. The effective required path is `tracker.settings.issuesPath`. Unknown provider keys are preserved by core parsing.     |
| Defaults       | Lifecycle defaults are `Status`, active `Ready`/`In Progress`, terminal `Done`/`Cancelled`, and no planning states. Unless explicitly configured, blocker checks use the first active state (`Ready` with these defaults). |
| Credentials    | `secretEnvironmentNames()` is empty: file fixtures require no secret or environment variable.                                                                                                                              |
| Validation     | A supplied `path` must be a non-empty string and fails configuration parsing with `WorkflowValidationError` when invalid. A missing runtime `issuesPath` instead fails each adapter operation with a plain `Error`.        |

There is no provider request pagination, page size, timeout, or rate limit: the
adapter reads one local JSON file per operation. A missing file yields an empty
candidate list. An unreadable file, malformed JSON, or a top-level non-array is
a file/response failure rather than a silent partial read.

## Normalized issue contract

| Field or condition                  | File mapping                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id` and `native_ref`               | Fixture `id` is retained unchanged. `native_ref` is retained when supplied; otherwise it defaults to `{ itemId: tracker.itemId }` only for a string item ID, or `{ itemId: null }`.                                                                                                                                |
| State, labels, priority, timestamps | Valid fixture values are preserved; fixture authors supply their normalized form. The adapter does not invent provider-specific state, label, priority, or timestamp mappings.                                                                                                                                     |
| `dispatchable`                      | An omitted value defaults to `true`; `false` and `dispatchReason` can be supplied to exercise the adapter-neutral scheduler gate. Pickup-label filtering remains available through the shared normalized filter.                                                                                                   |
| Malformed and optional fields       | Entries lacking the checked shape (`id`, `identifier`, `state`, object `repository`, object `tracker`, or a boolean `dispatchable` when supplied) are skipped with a diagnostic. This check is not exhaustive: for example, a missing `title` is currently not rejected. Optional `assigneeId` defaults to `null`. |

## Native tools and errors

The file adapter exposes no provider-native agent tool.

This table records the Symphony §11.4 target mapping required by §11.2. The
file adapter does not currently emit any structured error `category`; its
configuration parse failure is `WorkflowValidationError` and its runtime file
failures are plain errors.

| Provider-native failure                        | §11.4 target category                  | Current adapter surface              |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------ |
| File read failure or invalid JSON payload      | `tracker_request` / `tracker_response` | Plain read/JSON error                |
| No corresponding provider HTTP status          | `tracker_status`                       | Not applicable                       |
| No pagination                                  | `tracker_pagination`                   | Not applicable                       |
| No remote quota                                | `tracker_rate_limited`                 | Not applicable                       |
| Invalid `tracker.provider.path`                | `invalid_tracker_config`               | Parse-time `WorkflowValidationError` |
| Missing required `tracker.settings.issuesPath` | `invalid_tracker_config`               | Per-operation plain `Error`          |
| No credentials required                        | `missing_tracker_secret`               | Not applicable                       |

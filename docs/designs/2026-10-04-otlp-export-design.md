# Orchestrator OpenTelemetry export

- **Status:** Draft
- **Date:** 2026-10-04
- **Symphony Layers:** Configuration, Observability (primary); Coordination, Execution, Integration (boundary effects); Policy (dogfood planning only)
- **Tracking Epic:** [#794](https://github.com/hojinzs/github-symphony/issues/794)
- **Baseline:** Initial code audit at `dcfcaffc00925082bd7d98e3b2a7e00438ec4b4c`; review refresh against `main` at `750119aa` (documentation closeout only)
- **Approval:** User constraints below are fixed. Release and technical choices are recommendations awaiting review, not accepted decisions.
- **Delivery plan:** [Independent dogfood slices](2026-10-04-otlp-export-dogfood-plan.md)

## Current code versus the September Epic

The issue, timeline, native sub-issues, PR search, Project fields, and source were
rechecked on 2026-10-04. #794 is OPEN / Backlog with the `epic` label, assigned
to `hojinzs`, with zero comments and zero native sub-issues. Its timeline has a
related #890 reference, but no implementation PR reference. Searching all PRs
for OTLP/OpenTelemetry and the document tree found no dedicated approved design,
ADR, or implementation. This is bounded search evidence, not a claim about all
possible differently named work. PR [#982](https://github.com/hojinzs/github-symphony/pull/982)
is an OPEN documentation proposal for a management plane, not an OTLP dependency.

| September #794 statement / candidate          | Current evidence at the baseline                                                                                                                          | Design consequence                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 25 structured event kinds                     | `core/src/observability/structured-events.ts` has 27 discriminants                                                                                        | Cover every current kind; unknown future kinds default to INFO                                                            |
| Append redacts and mirrors events             | `orchestrator/src/fs-store.ts:appendRunEvent` redacts, hashes the redacted JSON, durably appends, then best-effort mirrors identical bytes                | Preserve ordering, integrity and mirror warning semantics; do not refactor files into an interchangeable best-effort sink |
| Flat and nested issue fields; partial run IDs | Still present; run ID also comes from append context                                                                                                      | Normalize only at the export boundary                                                                                     |
| `observability.otlp` / SDK / exporter absent  | No matching configuration, package or lockfile dependencies, or exporter implementation                                                                   | Additive extension; all examples below describe future behavior                                                           |
| HTTP cannot expose token counts at all        | Dashboard masks exact `tokenUsage` keys; numeric `codexTotals` survive. CLI status consumes totals; orchestrator monitoring also exposes aggregate tokens | Correct the motivation; OTLP adds external collection rather than filling an entirely absent API                          |
| Token usage from every runtime                | Worker consumes `agent.tokenUsageUpdated`; Claude print mapper emits no such event, even when result `usage` exists                                       | Codex accounting is measurable; Claude tokens are unsupported, not zero                                                   |
| Simple cumulative runtime sum                 | Snapshot builder groups by project/issue/runtime lifecycle, selects latest cumulative runtime session, and has a legacy fallback                          | Reuse the authoritative projection; never sum recovery session runtime again                                              |
| Instance registry ID for resources            | Standalone project ID derives from project folder; extraction design forbids restoring removed registries                                                 | Stable project identity plus a process incarnation UUID                                                                   |
| Lazy import removes size/startup cost         | CLI tsup bundles workspace packages (`noExternal`), splits ESM chunks, and has multiple entries                                                           | Measure runtime loading and installed/packed size separately                                                              |
| Snapshot hook can export                      | `notifyTick` awaits `onTick`; `saveProjectStatus` is in the reconciliation path                                                                           | Only enqueue/copy bounded state here; exporter network I/O cannot be awaited                                              |
| Child OTEL values are uniformly excluded      | Host inheritance is allowlisted, but `buildProjectExecutionEnv` merges the project `.env` wholesale                                                       | Explicitly exclude exporter auth provenance at worker construction; test project `.env` too                               |
| Extraction planned                            | Initial audit found the extraction design labelled Draft; main closeout now marks it Shipped (PR #973); `retained-decisions.ts` is imported by the façade | Keep pure decisions effect-free; use existing service/store owners                                                        |
| Epic can be picked up                         | `WORKFLOW.md` already excludes `epic`                                                                                                                     | Preserve parent exclusion; no workflow edit is needed now                                                                 |

Paths in this table are under `packages/`. Relevant current contracts are
`core/src/contracts/{state-store,status-surface}.ts`, workflow
`{config,parser,loader}.ts`, runtime Claude `events.ts`, CLI
`{logs,doctor,status}.ts`, CLI `tsup.config.ts`, and dashboard `server.ts`.
The [extraction design](2026-09-14-orchestrator-extraction-scope.md) retains the
service as the effect-owning façade; telemetry does not move effects into its
pure decision modules or create another state store/metrics authority.

## Fixed constraints and proposed release boundary

**Fixed by the user:** each project orchestrator owns its execution state;
exporter failure cannot fail or delay dispatch/reconciliation; SDK and exporter
ownership is orchestrator-side; no new SDK or OTEL authentication values in
worker/coding-agent children; no tracker semantics in the core telemetry
contract; no dependency on budget cap #645 or Control Plane #982; no upstream
spec edits. This PR only documents work and creates no issues or runtime changes.

**Recommended first release:** structured orchestrator Logs and the Metrics
catalog below, OTLP/HTTP protobuf, explicit enablement, bounded best-effort
export, CLI operational diagnostics, and both receiver and Collector tests.
Traces, run/turn span persistence, worker text logs, raw coding-agent protocol
payloads, coding-agent native OTel opt-in, a new UI, management plane, alerting,
backfill, delivery guarantees, and Claude token support are separate follow-ups.
Existing UI/API token redaction stays unchanged.

#794 closes only after the approved first-release children are merged,
operator-facing docs and extension ADR are merged, regression/Collector gates
pass, and separate dogfood and Collector receipt evidence is reviewed. Traces
and Claude support do not keep this Epic open. Change the Epic's current
endpoint-only activation and traces candidate/completion wording after approval,
as an explicit approved scope update, not during this documentation stage.

## Recommended choices for review

| Choice                | Recommendation                                                                     | Trade-off / alternative                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Signals and transport | Logs + Metrics; only `http/protobuf` in v1                                         | gRPC adds transport/dependencies; traces add persistent context/lifecycle semantics                          |
| Enablement            | YAML `enabled: true` required; endpoint alone never enables                        | Less environment-only convenience; avoids ambient credentials activating export                              |
| Configuration         | Explicit YAML wins; env fills missing transport fields                             | Host emergency changes require editing YAML or restart rather than silently overriding policy                |
| Export implementation | Official isolated SDK providers and protobuf exporters                             | Dependency/Logs API churn; direct JSON is smaller but owns serialization, retry, temporality and conformance |
| Totals representation | Absolute history totals as gauges; process tick outcomes as cumulative counters    | History gauges are not event counters; historical totals must not be summed across process incarnations      |
| Identity/cardinality  | Project resource identity, random process UUID; no issue/run/session metric labels | Cross-restart querying requires project grouping and latest-value selection                                  |
| Reload                | Restart-required; applied and pending descriptors visible                          | Prevents hot endpoint switching; disable edits also require restart                                          |
| Claude tokens         | Explicit unsupported limitation; separate follow-up                                | Mixed-runtime token totals represent measured Codex usage only                                               |

Only release scope and the Claude completion boundary need a product decision
before registration. The technical defaults are concrete review proposals;
review can amend them before marking this design Approved. No benchmark result
or SDK version compatibility is assumed in this Draft.

## Configuration contract (proposed)

`observability` and `otlp` are YAML mappings. Unknown fields _inside this new
owned block_ are validation errors; existing unknown top-level compatibility is
unchanged. No project-config override layer is introduced in v1.

| Field under `observability.otlp` | YAML type                                                                           | Semantics                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`                        | boolean, default `false`                                                            | Only literal `true` enables; string booleans invalid                                                                  |
| `endpoint`                       | optional non-empty string                                                           | General HTTP base URL, literal or whole-value environment reference                                                   |
| `protocol`                       | optional string enum                                                                | Only `http/protobuf`; default when enabled                                                                            |
| `headers`                        | optional mapping of HTTP header name to string, or whole-value env-reference string | Mapping values must be secret references; whole reference resolves OTEL header-list grammar; absent defaults to empty |
| `resource_attributes`            | optional mapping of string to string/boolean/finite number                          | Scalar values only; strings can be whole-value references; no null, arrays, nested mappings                           |
| `logs`, `metrics`                | optional mappings                                                                   | Each accepts `endpoint`, `protocol`, `headers` with the same types; endpoint here is a complete signal URL            |

```yaml
observability:
  otlp:
    enabled: true
    endpoint: env:SYMPHONY_OTLP_BASE
    protocol: http/protobuf
    headers:
      Authorization: env:SYMPHONY_OTLP_AUTH
    resource_attributes:
      deployment.environment.name: staging
      symphony.operator.cluster: dogfood
    # Optional complete URL; no suffix is added:
    metrics:
      endpoint: https://collector.example/tenant/v1/metrics
```

Alternative headers: `headers: env:OTEL_EXPORTER_OTLP_HEADERS`. The referenced
value uses the standard comma-separated `key=value` list (percent-encoded values
where necessary); reject duplicates case-insensitively, CR/LF and malformed
entries. Auth literals in YAML are rejected. Header maps replace lower-precedence
maps in full, never merge different credentials. `{}` explicitly suppresses env
headers. Reject attempts to set Host, Content-Length or Content-Type.

### Structural parsing versus owner-side resolution

Shared `parseWorkflowMarkdown` validates the OTLP block's field types and
reference syntax, collecting referenced names without looking up
any OTLP environment values. The worker calls this same parser with its stripped
`launcherEnv` to build its prompt and select a runtime; parsing must succeed
with enabled OTLP and no exporter secrets or endpoint-reference values present.
Do not require a worker opt-in mode, import SDK modules, or put resolved exporter
credentials into `ParsedWorkflow` or its shared cache.

A separate SDK-free `resolveOtlpConfiguration(raw, effectiveEnv)` helper reuses
existing environment-value resolution, but only the orchestrator startup/reload
owner and host CLI doctor call it. Orchestrator resolution validates required
transport values before dispatch and keeps the result in owner-local memory.
Normal workflow revision/cache logic uses the unresolved structural policy;
owner-side resolution participates in last-known-good and pending-config
handling. Other existing workflow fields retain their current parser behavior.
Worker structural success must not suppress orchestrator-side validation errors.

Environment references in that owner-side resolver reuse
`resolveEnvironmentValue`: `env:NAME`, `$NAME`,
and `${NAME}` as entire scalar values. Missing/empty references are field-specific
validation errors. Do not introduce interpolation such as `Bearer ${TOKEN}`;
store the entire `Bearer ...` value in the referenced variable. `$VAR` matches
the upstream environment indirection contract; `env:` is an existing local
parser extension. Whole header-list strings must be references, not literals.
References in resource strings use the same resolver, then the normal redactor;
secret-bearing resource values are rejected, not exported.

Resolve one immutable effective environment from project `.env`, then overlay
host process environment, matching existing daemon and CLI diagnostics. For each
transport field: signal YAML > general YAML > signal env > general env > default.
For `endpoint`, defaults are **absent**: enabling requires a general base or both
signal URLs. For protocol the default is `http/protobuf`; for headers empty.
Signal env means `OTEL_EXPORTER_OTLP_LOGS_*` or `_METRICS_*` for ENDPOINT, PROTOCOL,
HEADERS. Resource merge is `OTEL_RESOURCE_ATTRIBUTES`, then
`OTEL_SERVICE_NAME` for service name, then YAML user attributes; reserved identity
keys below cannot be overridden (equal values allowed, conflicts invalid).
Explicit YAML general configuration wins over a signal env value: this is
programmatic workflow policy, not an SDK doing its own env lookup. Pass resolved
options to SDK instances so they cannot independently reverse this order.

No block, `enabled` omitted, or `enabled: false` means no export, even if OTEL
environment values or endpoints exist. Validate provided structural field types
but skip reference resolution/transport validation while disabled, so missing
auth does not break a disabled workflow. Activation requires `enabled: true`;
there is no new `OTEL_*` enable flag. `OTEL_SDK_DISABLED=true` is an additional
veto. `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`, traces env, compression,
mTLS file env and temporality env do not configure this explicit v1 pipeline;
doctor lists these as unsupported without values. OS trust/TLS applies; no
custom mTLS configuration is claimed. Empty configured transport strings are
invalid rather than a silent fallback. When disabled, unsupported ambient
transport settings do not become errors.

### URL rules

The [official OTLP exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/#endpoint-urls-for-otlphttp)
uses general endpoints as bases with signal paths appended; signal endpoints are
complete URLs. Apply the same distinction to YAML:

| Source                                         | Logs request                               | Metrics request                               |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| General `https://collector.example`            | `https://collector.example/v1/logs`        | `https://collector.example/v1/metrics`        |
| General `https://collector.example/tenant/`    | `https://collector.example/tenant/v1/logs` | `https://collector.example/tenant/v1/metrics` |
| Logs signal `https://collector.example/custom` | Exact `/custom`                            | Resolved separately                           |
| Signal `https://collector.example`             | `/` when used for logs                     | `/` when used for metrics                     |

A general `/v1/logs` is still a base, not detected or rewritten as a signal URL.
Require http/https, host and optional port/path; reject credentials, query and
fragment to avoid ambiguous routing/secret disclosure. gRPC and `http/json`
are unsupported validation errors in this release, although OTLP defines them.

### Validation, applied configuration and reload

Invalid enabled configuration is a workflow validation error: startup stops
before dispatch; invalid reload keeps last-known-good workflow, emits the
existing visible warning, and retains applied exporter settings. A valid
configuration with a refused connection, TLS/auth failure or DNS timeout is an
exporter runtime failure: startup/dispatch continue, exporter status degrades,
and the bounded failure policy applies. No network preflight is required for
normal startup.

Freeze exporter settings at project startup. Reload parses/validates the new
workflow and applies existing reloadable policy normally, but different OTLP
settings become `pending` and `restartRequired=true`. Keep the old provider,
resource and destination; do not start an additional provider. This includes
enabled-to-disabled edits: warn that old destination remains active until restart.
A revert to applied settings clears pending state; repeated equal candidates do
not repeat warnings. Environment changes in `.env` participate in existing
workflow env-digest invalidation; process env changes require a new process.

Add a telemetry diagnostics projection to status, with enabled state, supported
signals, healthy/degraded/disabled state, last successful export per signal,
drop counts by bounded reason, applied/pending **safe descriptors** and
restartRequired. Descriptors expose endpoint origin/path without credentials,
protocol, resource identity and header _names_ only, never values. Secret change
comparison stays in process memory; never publish a secret digest to API/status.
CLI `project status` displays applied versus pending, and `doctor` validates the
same resolution contract. Its explicit enabled connectivity check has a 3s
budget per signal, reports HTTP/auth outcomes and may emit a marked diagnostic
probe; it does not dispatch or treat TCP reachability as successful telemetry
receipt. Disabled doctor never opens a connection. Update API tests for the
additive diagnostics projection; do not promise byte-identical status.json once
this field is added. Existing status fields remain equivalent.

## Persistence and export boundary

Core owns SDK-free configuration, normalized projections, severity and a small
best-effort publication contract. Proposed operations are synchronous,
non-throwing `offerEvent(redactedEvent, context)` and `offerSnapshot(projection)`;
`flush(deadline)`/`shutdown(deadline)` are orchestrator lifecycle operations,
never coordination requirements. A no-op is the default. The orchestrator owns
all SDK imports, providers, queues, diagnostics and transport. Integration
adapters contribute existing normalized data only; no GitHub Project status,
label or provider-native quota payload enters core metrics.

Event order: redact once using the existing function; serialize/hash and append
primary `events.ndjson` durably; attempt the existing mirror with its existing
catch/warning; offer the immutable redacted event with append-context run ID.
Primary append failure propagates under current persistence behavior and offers
nothing. Mirror failure remains a mirror warning and does not prevent export
after primary success. External queue/mapper/SDK errors are caught independently
and never convert an already successful append into an error. No exported data
is used to authorize state changes. Copy/encoding work is bounded; async drain
starts outside the append/tick stack.

Do not replay files at startup, consume the mirror as input, or change NDJSON
schema/serialization/hash. Integrity remains the hash of redacted JSON before
the integrity member is appended, not a hash of the OTLP record. Snapshot export
follows successful `saveProjectStatus`, taking the authoritative immutable
projection; it never awaits a metric reader/network request. Existing awaited
`onTick` remains separate; do not use it as a transport hook. Export diagnostics
must not populate coordination `lastError` or turn orchestration health degraded.

### Child credential boundary

Track the names referenced by exporter headers and strip those names, plus
OTEL exporter header/client-key credentials, from the final worker environment,
including project `.env` and explicit merges. Reuse existing environment-building
boundaries and their credential stripping/backstop, not a new broker. Do not
allow generic project env merging to leak a newly referenced auth name. Hook
children also must not receive these exporter-owned secrets. No new OTEL
inheritance allowlist or agent opt-in is added. Existing coding-agent environment
construction must remain isolated; test Codex, Claude and custom children.
If one stripped env name is shared with required agent/tracker auth, reject the
configuration with an actionable request to use a distinct exporter credential
name, whether OTLP is enabled or disabled. Run this name-only conflict check
whenever stripping applies, before constructing children; it never resolves or
prints secret values. For example, disabled OTLP referencing ANTHROPIC_API_KEY
must be rejected rather than silently stripping bare Claude's required auth.
When disabled, collecting auth reference names for stripping and conflict checks
needs no secret resolution; reserved exporter credential names remain excluded. Non-secret historical project env policy is otherwise
unchanged.

## Logs contract

Instrumentation scope is `gh-symphony.orchestrator`, version the shipped CLI
release. Emit event timestamp from ISO `at`, observed timestamp at local offer,
body equal to the stable event kind, and a redacted structured payload attribute
`symphony.event.payload` as JSON. Do not include raw worker text or agent params.
Map known scalars to typed attributes, not stringified numbers. Map legacy flat
issue fields and nested `issue` into `symphony.issue.id` and
`symphony.issue.identifier`; nested values win if both exist. Map project, run,
session, turn IDs when present; append context supplies missing run/project ID,
never an inferred session/turn. No trace/span IDs in v1. Preserve outcome/reason
and concise redacted error fields when present; retain existing integrity as an
optional `symphony.event.integrity` attribute from append context.

Missing optional values are omitted, not empty/null placeholders. Issue-related
records missing required issue context get `symphony.context.incomplete=true`;
do not fetch the tracker or invent an ID. Malformed timestamps drop only that
export record and count mapping failure, without altering local append. Payload
limit is 16 KiB after redaction; truncate exported payload at UTF-8 boundaries,
set `symphony.payload.truncated=true`, preserve context scalars; local bytes stay
unchanged. No more than 64 attributes. The JSON-string attribute
`symphony.event.payload` is explicitly exempt from the ordinary 1 KiB scalar
string limit and uses the 16 KiB UTF-8 payload limit; every other scalar string
is limited to 1 KiB. Configure SDK attribute limits and mapper truncation to
preserve this distinction. Tests cover payloads above 1 KiB but below 16 KiB,
and truncation above 16 KiB, without changing local file bytes.

Severity preserves CLI `getLevel`: ERROR/17 for `run-failed`, `turn_failed`,
`worker-error`, `hook-failed`; WARN/13 for `run-suppressed`, `run-retried`,
`run-finalization-deferred`, `run-ownership-skipped`; INFO/9 for all others.
Share a core pure mapper with CLI without changing existing filter results.
Any later severity improvement is a separately reviewed compatibility choice.

### Resource identity

Reserved resources: `service.name=gh-symphony`, `service.version` from release
metadata, `service.instance.id` a UUID generated once per orchestrator process,
`symphony.project.id` the existing stable project-folder ID,
`symphony.project.slug` from configured repository slug, and
`symphony.tracker.kind` the adapter kind. Do not restore the instance registry,
use PID alone, persist process UUID in run.json, or detect arbitrary host/env
resources. Multiple process incarnations are different series writers; project
identity supports cross-process views. Moving the folder changes current
project identity; a future management-plane identity is not required.

Metric resources contain project/process identity; per-point attributes are only
the bounded enums specified below. Issue/run/session/turn IDs, error text,
endpoint, model names and workflow revision must never be metric labels.
Custom resource attributes are limited to 16 configured scalar keys, may not
use reserved identity keys with conflicting values, and must not contain issue,
run, session or turn identifiers. Operators own the cardinality of approved
static deployment values.

## Metrics catalog

All values belong to one orchestrator's project; no tracker fetch, file scan,
or ownership mutation is allowed in a collection callback. Gauge temporality
is not applicable; cumulative counters/histograms start at process startup.
The latest committed projection supplies gauges every 10s; SDK point timestamps are collection
time, while status retains the projection source time. Repeated sampling is
not a new tick. The projection includes the measurement-supported flag, not just numeric totals.

| Name                         | Unit         | Instrument / temporality | Source and aggregation scope                                                                                                               | Point attributes                                                                      |
| ---------------------------- | ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `symphony.runs.active`       | `{run}`      | ObservableGauge / N/A    | `summary.activeRuns`, current active reservations (including retrying), matching current snapshot                                          | none                                                                                  |
| `symphony.runs.retrying`     | `{run}`      | ObservableGauge / N/A    | Current `retryQueue.length`; subset of active, not additive                                                                                | none                                                                                  |
| `symphony.health`            | `1`          | ObservableGauge / N/A    | Three one-hot values from snapshot health; exporter failure excluded                                                                       | `state=idle,running,degraded`                                                         |
| `symphony.poll.interval`     | `ms`         | ObservableGauge / N/A    | `effectivePollIntervalMs`; omit if absent                                                                                                  | none                                                                                  |
| `symphony.tick.outcomes`     | `{decision}` | Counter / cumulative     | Add each committed tick's `summary.dispatched/suppressed/recovered/skipped` once; process-local outcomes, not unique issues                | `outcome=dispatched,suppressed,recovered,skipped`                                     |
| `symphony.tokens.total`      | `{token}`    | ObservableGauge / N/A    | Supported retained-history input/output/total projection using the same token arithmetic as `codexTotals`; exclude unknown provenance      | `direction=input,output,total`, `runtime=codex`                                       |
| `symphony.tokens.supported`  | `1`          | ObservableGauge / N/A    | Adapter mapping capability: Codex 1, current Claude 0; no claims about usage being zero                                                    | `runtime=codex,claude`                                                                |
| `symphony.runtime.total`     | `s`          | ObservableGauge / N/A    | `codexTotals.secondsRunning`, all retained lifecycles plus live elapsed at snapshot time; lifecycle dedup already in builder               | none                                                                                  |
| `symphony.tick.duration`     | `s`          | Histogram / cumulative   | New monotonic timer around the serialized `runOnceInternal` invocation, including durable state work, excluding `onTick`, sleep and export | `outcome=success,failure`                                                             |
| `symphony.telemetry.dropped` | `{record}`   | Counter / cumulative     | Local pipeline loss, once per removed record                                                                                               | `signal=logs,metrics`, `reason=queue_full,timeout,permanent,shutdown,mapping,partial` |

Histogram explicit bounds: 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120 seconds.
Tick duration is absent from current snapshots; this small read-only measuring
point supports the non-blocking performance gate. Do not add it to persisted
run or snapshot schema. Metric diagnostics themselves must bypass recursive
export error handling (dropping a diagnostics batch cannot generate another
batch immediately).

No `symphony.tracker.ratelimit.remaining` in v1: snapshot `rateLimits` may contain
agent or provider-specific shapes and is not a normalized numeric tracker
contract. Keep redacted structured rate-limit context in logs where already
available; later numeric metrics require an adapter-neutral separate contract.

### Repetition, restart and recovery rules

Assign an in-memory monotonic tick sequence at the façade; consume each successful
committed sequence once for outcome counters. Export collection/retry does not
increment it. Failed ticks contribute duration with failure but no committed
summary; repeated status reads contribute nothing. A recovered outcome means the
existing per-tick decision, not every loaded historical recovery record.

Never call `Counter.add(codexTotals)` per snapshot. Observe absolute history totals
as gauges, allowing correction/history retention to reduce a value honestly.
Do not observe token zero unless a measurement-capable runtime has actually
reported valid zero; omit series when no measured data exists. Claude worker
zero-initialized fields do not qualify as a measurement. The projection must
select supported Codex run data and reuse current per-session accounting;
exclude Claude from token series without changing existing persisted totals.
Current run records have neither runtime-kind attribution nor a measured-zero
flag. Add optional SDK-free measurement provenance to worker channel and run
records (`runtimeKind`, `tokenUsageMeasured`) in a dedicated preparatory slice:
set measured only after a valid absolute-usage update, persist with the existing
session delta, and preserve it on recovery. No events.ndjson change is needed.
Map runtime kind `claude-print` to the bounded support label `claude`; no
unbounded runtime/model names become labels. Historical records without provenance are unknown: omit them from the supported
token metric rather than classify them from today's workflow runtime or pretend
that legacy zeros are measured. The metric is therefore a supported retained
history subset, which can differ from legacy codexTotals; diagnostics describe
this coverage. Keep legacy API/file totals unchanged. A restart reloads the
provenance rather than classifying historical runs using current runtime config.
`total` is an alternative aggregate, not an extra direction to sum with input
and output. Do not sum attached per-issue cumulative values or turn deltas a
second time. Recovery runtime grouping stays in the existing snapshot builder.

Each restart resets process counters/start timestamps and creates a new resource
UUID; it does not replay Logs or re-add historical tick decisions. History gauges
may repeat the same total with new process identity: dashboards select the latest
incarnation for each project, never sum history across UUIDs. Live overlapping
orchestrators for the same project are an operational ownership error, not a
cross-process exactly-once export problem. Network retries can duplicate accepted
Log batches after ambiguous timeouts; no exactly-once delivery is promised.
Metric retry sends the same points/timestamps, never re-records instruments.
Backend ingestion must honor cumulative-point semantics; summing export payloads
is not a valid accounting test. [OTel metric data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/)
defines stream identity, timestamps and reset behavior; the gauge choice above
is a repository-local projection decision.

## Bounded operation and failures

| Control             | Proposed fixed v1 contract                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log queue           | 2,048 records including retry/in-flight accounting, at most 8 MiB encoded payload; drop newest when either bound is reached                                    |
| Log batch           | Up to 256 records or 1 MiB encoded payload, drain every 1s or when batch threshold reached                                                                     |
| Metrics state       | One latest immutable projection; coalesce pending snapshots, no unbounded snapshot queue; one in-flight batch plus one pending collection                      |
| Metric collection   | Every 10s; fixed bounded instrument/attribute catalog                                                                                                          |
| Request concurrency | One in-flight request per signal; no parallel retries for a batch                                                                                              |
| Request timeout     | 3s per attempt; total batch lifetime 10s from first attempt including retry delay                                                                              |
| Retry               | At most two retries; exponential 0.5s/1s with jitter, honor Retry-After within remaining lifetime; discard if wait exceeds lifetime                            |
| Shutdown            | Stop offers/timers, flush both signals concurrently with one shared 5s deadline, abort requests and discard remainder; no extra shutdown deadline per provider |

Retry only connection/transient transport errors and HTTP 429/502/503/504;
other 4xx/5xx are permanent. Successful partial rejection counts rejected records
and does not retry the accepted batch. Use the [OTLP failure protocol](https://opentelemetry.io/docs/specs/otlp/#otlphttp)
for response semantics. SDK internal retries must share these limits; never stack
an outer retry loop on an unbounded inner loop. Payload-size/concurrency bounds
apply across SDK and adapter queues, not independently to two 2,048-record queues.
Metrics failed batches expire; next collection uses current cumulative values.
Gauge coalescing is normal sampling, not a dropped-record alarm.

Warn immediately on first failure per signal/category (transport, auth/permanent,
queue loss). During a continuous episode, summarize no more than once per 60s.
A successful request resets transport/auth episodes and emits one recovery
notice; queue recovery resets only once occupancy is below half and a drain
succeeds. A subsequent failure can warn immediately. Shutdown loss is one final
local summary. Diagnostics go directly to redacted stderr and the safe status
projection, never `appendRunEvent`, the SDK logger, or the failed export queue.
Do not expose headers, body echoes, secret refs' values, or credentials in URLs.

Local durable persistence failure retains existing propagation semantics; it
must not be described as exporter loss. Exporter status does not affect poll
backoff, retry budgets, concurrency reservations, worker success or health.
Exporter network latency has no awaited edge into the hot path; tests must also
bound synchronous mapping/queue costs. Forced process death can lose queued
telemetry; local files are the recovery source for operators, not an automatic
replay spool.

## SDK and packaging choice

Recommend `@opentelemetry/api`, `api-logs`, `sdk-logs`, `sdk-metrics`, `resources`,
and `exporter-logs-otlp-proto` / `exporter-metrics-otlp-proto` in the orchestrator
implementation only. No `sdk-node`, auto-instrumentation, global provider,
worker or runtime SDK. Resolve options explicitly and use owned provider objects.
Version selection occurs at implementation against supported Node24 and a
compatible release set. Official JS status marks Metrics stable and Logs in
Development; pin compatible versions and test upgrades. [Official JS status](https://opentelemetry.io/docs/languages/js/#status-and-releases),
[exporter options](https://opentelemetry.io/docs/languages/js/exporters/).

A direct OTLP/HTTP JSON implementation can reduce third-party code, but then owns
protobuf JSON rules (64-bit values/timestamps), resource/scope grouping, metric
aggregation/temporality, partial success, retries and protocol upgrades. This
maintainability cost outweighs an unmeasured size win. SDK APIs may not expose
all queue/byte/deadline controls; an orchestrator adapter must enforce the
contract above, with a focused transport wrapper if needed. If enforcing a bound
requires replacing the SDK transport, document the concrete limitation and
re-review that slice before rollout; do not weaken bounds silently.

Disabled means no evaluation/import of OTel API/SDK/exporter/resource modules,
no providers, timers, queue allocation, sockets, global registration or probes.
The parser and SDK-free no-op/projection code may load. Dynamic import postpones
execution, not installation or distribution; OTel can remain in dependencies,
external node_modules or lazy chunks. CLI worker-entry's reachable graph must
not execute or initialize these imports. The package owner is orchestrator;
actual published CLI dependencies/chunks must be audited because workspace
packages are bundled and private package dependency ownership alone is not a
shipping guarantee.

Before allowing production enablement (after slice I's packaged audit), compare baseline and SDK branch: dependency
count/lockfile size, clean production install bytes, CLI npm-pack tarball bytes,
all ESM chunk bytes (including worker-entry), loaded modules for disabled start,
30 fresh-process startup samples (median/p95), idle RSS, and tick-duration p95
under healthy/slow/down receiver. Suggested review thresholds: disabled startup
p95 regression <=5% or 10ms (larger allowance), disabled idle RSS <=5 MiB, and
synchronous offer p95 <1ms for bounded records. Report actual sizes and assess
with the reviewer; no fictional zero-size claim. Use identical Node/OS/config
and record distribution/install conditions. These are future measurement gates,
not results of this documentation PR.

## Extension decision candidate (not Accepted)

Proposed ADR title: **Workflow-owned, orchestrator-local best-effort OTLP export**.
Status on creation: **Proposed**, later Accepted only following human approval.

Context: upstream §§13.2, 13.3, 14.2 and 17.6 permit remote sinks and require
correct independent orchestration; §18.2 recommends configurable observability.
The upstream does not require OTLP, this YAML block, process resources, queue
bounds, restart-required transport or these metric names. Decision candidate:
reserve `observability.otlp` in the Configuration Layer; implement Logs/Metrics
as Observability consumers of authoritative Coordination state, with
orchestrator-owned SDK and protected child environments. Consequences include
best-effort loss, additional package costs and restart-required endpoint changes.
Alternatives: env-only activation, direct JSON transport, wholesale durable-sink
refactor, traces in v1. The proposed choices do not change the upstream spec.
This is an explicit repository-local extension, not a normative replacement or
new conformance prerequisite; preserve existing local lifecycle/security choices.
Promote this candidate into `docs/adr/YYYY-MM-DD_slug.md` only with approved
wording. This Draft does not label any technical choice Accepted.

## Acceptance test contract (future implementation)

| TC    | Test and required evidence                                                                                                                                                                                                                                    | Level                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| OT-01 | Decode real protobuf Logs/Metrics, correct signal paths, timestamps, severity, resources, auth header, units/attributes                                                                                                                                       | In-process receiver; Collector confirms compatibility |
| OT-02 | YAML > signal env > general env and process > `.env`; signal URLs exact; general base suffixes; header-map replacement; missing refs/type/protocol errors                                                                                                     | Unit tables + receiver                                |
| OT-03 | No block, omitted enable, explicit false and SDK_DISABLED veto never activate on ambient OTEL values; no SDK module evaluation, sockets/timers; doctor disabled                                                                                               | Unit/CLI packaged process                             |
| OT-04 | Refused endpoint, stalled request, auth error, partial success, Retry-After, permanent errors and recovery warning reset; dispatcher still completes with unchanged scheduling                                                                                | Fake clock/receiver + Collector outage blackbox       |
| OT-05 | Queue byte/count saturation and concurrent drains stay bounded; newest drops exactly once; metric snapshots coalesce                                                                                                                                          | Unit stress tests                                     |
| OT-06 | Repeated snapshot/collection/retry contributes no duplicate outcomes/tokens/runtime; restart UUID and reset; recovery lifecycle totals match authoritative fixtures                                                                                           | Existing accounting fixtures + receiver               |
| OT-07 | Primary append failure offers nothing; mirror failure still offers once; original redacted NDJSON bytes, integrity verification and mirror output unchanged                                                                                                   | fs-store regression fixtures                          |
| OT-08 | Codex absolute updates/session deltas remain correct; valid measured zero distinguished from absent; Claude raw `usage` does not create token series; supported=0                                                                                             | Worker/runtime/core fixtures                          |
| OT-09 | Enabled OTLP worker starts with stripped credentials and unresolved endpoint refs; project `.env`/process/arbitrary header-ref names absent from children; enabled and disabled shared-name conflicts rejected without value resolution; existing auth intact | Environment contract tests + stub child               |
| OT-10 | Valid reload leaves applied exporter unchanged and displays pending; disable warning honest; revert clears; invalid reload uses last-known-good                                                                                                               | Service/CLI/status/API fixtures                       |
| OT-11 | Graceful shutdown waits <=5s total including both providers; timeout aborts/drops; forced death does not trigger historical replay                                                                                                                            | Packaged subprocess + receiver                        |
| OT-12 | Exporter diagnostics never re-export recursively, never set coordination lastError; secret echoes absent from all output                                                                                                                                      | Fault injection/unit                                  |
| OT-13 | Packaged CLI resolves lazy dependencies/chunks in clean install; disabled startup/RSS and offer latency gates measured                                                                                                                                        | Packaging benchmark                                   |
| OT-14 | Real Collector produces attributable received Log/Metric evidence, endpoint outage leaves file-tracker work complete                                                                                                                                          | Docker blackbox                                       |
| OT-15 | Dependency-ready bot-assigned child dispatched, PR/test/merge evidence and parent exclusion confirmed, independently of OTLP receipt                                                                                                                          | Supervised dogfood after approval                     |

In-process receiver tests inspect wire protobuf, deterministic timing and
failure injection without Docker. They cannot prove Collector interoperability,
container packaging or production reachability. Collector Docker tests pin an
image, configure OTLP receivers plus file/debug output, and save received records
with project/process identity. Reuse standalone-project fixtures; isolate Compose
project/port/output across worktrees. Update `AGENT_TEST.md` scenario table when
adding the runnable scenario, not as if it exists in this PR.

Run Docker preflight through the repository runner. Status 69 for missing Docker,
unresolvable Compose or unreachable daemon is the narrow documented unattended
worker limitation: record command/scenario/status, finish available gates and
leave Collector confirmation to operator/CI. After preflight succeeds, all
scenario failures remain failures; status 125 is not the exception. Do not
install a daemon in workers or add host provisioning to this Epic. An existing
standalone smoke run is not OT-14 Collector evidence.

Dogfood evidence proves Symphony delivered the approved implementation slice;
Collector evidence proves export arrived. Require both, with commit/config
identity, receiver timestamps and redacted artifacts; one cannot substitute for
the other. This design PR executes documentation checks and existing unit tests,
not the proposed OT-01–OT-15 implementation tests.

## Documentation review checks

Simple document TCs: D-01 metadata/status and no ambiguous accepted choices;
D-02 valid local links/index entries; D-03 upstream spec and runtime files
unchanged; D-04 metric/config/operational contracts and all OT test IDs present;
D-05 future issue templates carry required sections, sizes and dependencies.
Run these plus targeted formatting, whitespace checks and mandatory `pnpm test`.
Build/lint/typecheck additionally validate the baseline where available. Runtime,
CLI, package and configuration living documents stay current-behavior references
now; each implementation slice updates `README.md`, `packages/cli/README.md`,
`docs/architecture.md`, `docs/configuration.md` and `AGENT_TEST.md` as applicable.
No release changeset is needed for this documentation-only change.

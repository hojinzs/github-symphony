## MODIFIED Requirements

### Requirement: Symphony core SHALL own prompt rendering and app-server session lifecycle

The system SHALL render the issue prompt from the workflow prompt template and runtime variables using strict variable checking, start an app-server session in the issue workspace, drive thread and turn lifecycle according to the Symphony execution contract, and use continuation plus retry semantics to decide whether to resume work after a worker exit. Core state SHALL persist a stable minimal execution snapshot sufficient for reconciliation, retry, continuation, and observability without making raw app-server transport payloads part of the stable core contract.

Prompt rendering SHALL operate in strict mode by default: if the rendered output contains unresolved template variables (e.g., `{{unknown.var}}`), the renderer SHALL raise a template_render_error. Unknown filters SHALL also raise an error. This ensures prompt integrity and prevents silent template misconfiguration.

#### Scenario: First run uses the full issue prompt

- **WHEN** Symphony starts the first execution attempt for an actionable issue
- **THEN** it renders the prompt template with the normalized issue payload and `attempt = null`
- **THEN** it starts an app-server thread and turn for that prompt in the issue workspace

#### Scenario: Continuation run resumes an active issue

- **WHEN** a worker exits normally after exhausting its in-process turn loop while the issue remains actionable
- **THEN** the orchestrator schedules a short continuation retry for that issue
- **THEN** the next worker session continues the issue on the same workspace instead of treating it as a brand-new dispatch

#### Scenario: Worker reports a stable minimal execution snapshot

- **WHEN** a worker starts or updates an assigned issue session
- **THEN** it reports stable identifiers and summarized lifecycle state such as run, attempt, retry kind, session, thread, status, timestamps, and exit classification
- **THEN** raw transport frames and full transcript payloads remain outside the canonical core snapshot

#### Scenario: Prompt rendering fails on unknown variables

- **WHEN** the workflow prompt template references a variable that is not in the rendering context (e.g., `{{unknown.field}}`)
- **THEN** the renderer raises a template_render_error instead of preserving the raw template expression in the output
- **THEN** the run attempt fails and the orchestrator applies its retry policy

#### Scenario: Prompt rendering fails on unknown filters

- **WHEN** the workflow prompt template uses an unsupported filter expression
- **THEN** the renderer raises a template_render_error
- **THEN** the run attempt fails with a clear error identifying the unknown filter

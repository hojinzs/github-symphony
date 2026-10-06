# TC-26: OTLP child credential ownership (OT-09)

## Setup

Use the packaged standalone project runner with Docker available:
`./e2e/run-standalone-project-e2e.sh`.

## Steps

1. Start the two fixture projects with enabled structural OTLP policy and arbitrary
   header references from project `.env` and daemon process environment.
2. Dispatch file-tracker issues to the captured stub workers.
3. Require the `otlp_credentials=isolated` worker log marker before completion.
4. Verify both normal project dispatches and clean shutdown still succeed.

## Expected

Workers receive neither arbitrary exporter auth reference nor reserved OTLP
headers. The stub checks the actual process environment before printing its
marker; a forbidden credential causes a nonzero exit. Endpoint references remain
structural in the workflow; no SDK or Collector connection is activated.

Service tests also capture hook environments and actual Claude/custom spawn
options plus the prepared Codex launch environment, preserving provider auth and
tracker host ownership. Name-only enabled/disabled conflict rejection is unit
covered, including absent `ANTHROPIC_API_KEY` and exporter endpoint values.

## Cleanup

The runner removes its Compose project and volumes. In unattended workers, only
preflight exit 69 is the documented Docker prerequisite limitation; record this
scenario as unconfirmed until an operator or CI runs it.

# TC-26: OTLP child credential ownership (OT-09)

## Setup

Use the packaged standalone project runner with Docker available:
`./e2e/run-standalone-project-e2e.sh`.

## Steps

1. Temporarily enable OTLP in one empty fixture and run the audited CLI with
   `--once` under a 20-second timeout. Require exit code 0, applied enablement in
   JSON status, no coordination error and no remaining project lock. Restore
   disabled policy. Independent library rejection remains covered by TC-29.
2. Start the two fixture projects with disabled structural OTLP policy and arbitrary
   header references from project `.env` and daemon process environment.
3. Dispatch file-tracker issues to the captured stub workers.
4. Require the `otlp_credentials=isolated` worker log marker before completion.
5. Verify both normal project dispatches and clean shutdown still succeed.

## Expected

Workers receive neither arbitrary exporter auth reference nor reserved OTLP
headers. The stub checks the actual process environment before printing its
marker; a forbidden credential causes a nonzero exit. Endpoint references remain
structural in the workflow. Disabled policy still owns credential names, and
the credential-isolation dispatches run with export disabled. The initial enabled
one-tick check exercises the complete audited CLI composition; unreachable
receiver diagnostics do not fail coordination.

Service tests also capture hook environments and actual Claude/custom spawn
options plus the prepared Codex launch environment, preserving provider auth and
tracker host ownership. Name-only enabled/disabled conflict rejection is unit
covered, including absent `ANTHROPIC_API_KEY` and exporter endpoint values.

## Cleanup

The runner removes its Compose project and volumes. In unattended workers, only
preflight exit 69 is the documented Docker prerequisite limitation; record this
scenario as unconfirmed until an operator or CI runs it.

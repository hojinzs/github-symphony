## ADDED Requirements

### Requirement: Orchestrator SHALL expose a refresh trigger endpoint

The orchestrator status API SHALL provide a `POST /api/v1/refresh` endpoint that queues an immediate tracker poll and reconciliation cycle. The endpoint SHALL return `202 Accepted` with a JSON response indicating whether the request was queued and whether it was coalesced with an already-pending refresh. Repeated rapid requests SHALL be coalesced so that at most one extra reconciliation cycle is triggered.

#### Scenario: Refresh triggers immediate reconciliation

- **WHEN** an operator or extension sends a POST request to `/api/v1/refresh`
- **THEN** the orchestrator queues an immediate poll and reconciliation cycle outside the normal polling cadence
- **THEN** the endpoint responds with `202 Accepted` and a JSON body including `queued: true`

#### Scenario: Concurrent refresh requests are coalesced

- **WHEN** multiple POST requests arrive at `/api/v1/refresh` before the triggered reconciliation starts
- **THEN** the orchestrator performs only one extra reconciliation cycle
- **THEN** subsequent requests receive a response with `coalesced: true`

#### Scenario: Refresh endpoint rejects non-POST methods

- **WHEN** a GET or other non-POST request is sent to `/api/v1/refresh`
- **THEN** the endpoint responds with `405 Method Not Allowed`

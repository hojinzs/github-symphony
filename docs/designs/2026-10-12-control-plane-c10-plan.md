# C10 bounded read lane implementation plan

Issue #1014, Epic #983. Integration and Observability cross-layer slice.
The approved management-plane design remains the authority. This is a
repository-local extension; no upstream Symphony specification change or
orchestration-core policy change is intended.

## Owned interfaces and files

- `fleet-control-plane/src/reads.ts`: ephemeral requests/results, independent
  admission, expiry, session fencing and bounded retention. Uses existing C01
  schemas/constants and typed synchronous C04/C05/project peers. No command
  storage or process effects. At most 1024 retained requests by default is a
  repository implementation safeguard; accepted reads retain the specified
  60-second result lifetime. A full registry returns the existing busy code.
- `fleet-control-plane/src/read-routes.ts`: framework-independent detail/read
  route dispatcher, actual C04 browser security, v1 error envelopes. The fleet
  listener and shared agent poll/result transport stay consumer-owned.
- `reads.test.ts`, `read-routes.test.ts`: actual SQLite and enrollment with
  independent typed project/session fixture tables; no implementation mock.
- C09 `management-agent/LocalReadAdapter`: required integration peer for CP-12
  containment, missing files, traversal, rotation, truncation and known streams.
  C10 must exercise it through blackbox tests, without duplicating its reader.
- Related package/CLI/root docs, architecture mapping, AGENT_TEST scenario,
  CLI patch changeset and executable E2E/mutation evidence complete delivery.

## Remaining delivery gates

Complete cached-summary/historical detail peer contract, C09 composition,
invalid/recovery coverage and Docker blackbox evidence. Run full repository
lint/test/typecheck/build. Require reached forbidden-condition probes and
mutation evidence for each added test. Refresh PR #1046 and the cycle-1 workpad,
publish all commits and hand off only when the Completion Bar passes.

## Boundaries

C06 owns observation/current projection and retained run summaries (maximum
100 per project); typed fixture boundaries may stand in for its unavailable
implementation. C10 owns how details are fetched and historical/unavailable
semantics. C09 owns filesystem reading; C07 owns lifecycle commands. No native
service installation, fleet UI or per-project web-server conversion is included.

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

## Delivery verification

`getReadView` and historical/no-store HTTP headers preserve protocol v1 result
bodies. The optional transactional `receiveRunSummaries` boundary leaves C06
merge/pruning ownership intact. TC-31 composes actual C04/C05/C09 with HTTPS;
its independent project/history tables are typed sibling fixtures. Run full repository
lint/test/typecheck/build. Require reached forbidden-condition probes and
mutation evidence for each added test. Refresh PR #1046 and the cycle-1 workpad,
publish all commits and hand off only when the Completion Bar passes.

## Boundaries

C06 owns observation/current projection and retained run summaries (maximum
100 per project); typed fixture boundaries may stand in for its unavailable
implementation. C10 owns how details are fetched and historical/unavailable
semantics. C09 owns filesystem reading; C07 owns lifecycle commands. No native
service installation, fleet UI or per-project web-server conversion is included.

## Acceptance mapping and validation scope

- Independent concurrency/expiry lane: `reads.ts`, tested alongside actual C07
  command submission and with two enrolled environments sharing a local ID
  (CP-01/17). C04 authoritative revocation fences stale projections (CP-11).
- Historical/unavailable semantics: `getReadView`, v1 result timestamp and
  historical/no-store detail headers; offline, expiry and restart tests (CP-05/12).
  C06 receives summaries through a transaction hook; tests verify rollback,
  retry and completed replay. Raw logs never reach that hook (CP-15).
- CP-12 normal/invalid/recovery and U04/U07: TC-31 HTTPS operator requests and
  actual C09 adapter over real run records/logs cover known details, invalid
  stream, traversal, missing file, append, rotation/truncation reset and offline
  follow state. Unit tests verify UTF-8 per-request and retained JSON bounds.
- No upstream spec modification or new tracker policy. The extension conforms
  to upstream §§3.2/13.3/13.4 observability separation and explicit unavailable
  diagnostics. Added registry/non-log payload caps are implementation safeguards
  documented in configuration, not a protocol rewrite.
- Docker runner attempted twice, both stopped in daemon preflight with exit 69;
  follow-up #1048 records the environment exception under WORKFLOW flake policy.
  Native macOS contract passed; no Linux/container result or systemd/launchd
  isolation claim is made. CP-02/03/04/06–09/13/14/16/18–23 lifecycle, inventory,
  provisioning and native-service concerns remain owned by sibling slices;
  C10 neither changes them nor asserts their completion.

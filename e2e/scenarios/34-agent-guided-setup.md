# TC-34 — shared CLI guided agent setup

Scope: Configuration and Integration, C13 (#1017), repository-local management
extension. Preserve upstream spec and existing local project/per-project web APIs.

Run `pnpm build`, `node e2e/agent-setup-e2e.mjs`, then
`node e2e/agent-setup-probes.mjs`. Linux Docker:
`./e2e/run-agent-setup-e2e.sh`.

The compiled CLI talks to an independent trusted HTTPS peer. Actual private
registry persistence, hidden/stdin token unit cases, public command parsing,
first authenticated empty inventory, foreground owner locking and canonical
allowlist commands are exercised. Compiled real Linux/macOS native service
adapters talk to independent OS-command peers: fail installation/start once,
resume saved identity without token input, acquire the shared registry lock at
service startup, and run status/stop/restart/uninstall preserving saved data.

| Case                                                                            | Evidence                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| U02 / walkthrough 9: install/help/version, one-use token input and saved resume | Shared CLI help/version and actual HTTPS enrollment; typed hidden-terminal input tests     |
| CP-22: partial install/start failure then retry                                 | Actual saved registry and native adapters, independent OS peers for both platforms         |
| CP-22: other server / unsafe persisted identity                                 | Rejected conflicting origin; private 0600 registry mode checked                            |
| CP-21: connected zero-project host                                              | Actual foreground process sends authenticated observation before polling                   |
| CP-23 / walkthrough 10: foreground conflict, service lifecycle and limits       | A second compiled CLI foreground process fails; OS-peer lifecycle and typed service checks |
| CP-14: local registration/removal                                               | Existing-folder add/list/remove through compiled CLI, no project stop                      |
| CP-11: credential separation                                                    | CLI transcript excludes token and saved bearer credential; unit raw input never echoes     |

Each black-box assertion emits `reached:`. Ten forbidden-outcome probes run the
same compiled scenario, plant a forbidden observation at one named assertion,
and require both the intended marker and AssertionError. These probes establish
that the assertion is reached and detects its forbidden outcome; source mutations
of routing, token reading, config safety, native sequencing and runtime-read
behavior are separately recorded in the issue workpad.

Report actual macOS host and Linux Docker evidence separately. The Docker
container simulates OS command peers and has no native systemd/launchd lifecycle
acceptance claim. Native CP-23 preservation of remotely started orchestrators,
Linux linger/session teardown and macOS logout/login remain C11/C12/C21 OS gates.
The default runtime's registered-project inventory requires the explicit typed
fleet identity resolver; C13 neither invents an allocation route nor claims full
fleet acceptance. Its typed fixture exercises actual inventory/local-read
composition. Docker preflight exit 69 follows AGENT_TEST.md's worker exception.

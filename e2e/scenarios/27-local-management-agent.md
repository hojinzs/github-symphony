# TC-27: Local management agent contract (C03)

Run `./e2e/run-management-agent-e2e.sh` for Linux container confirmation. After
`pnpm build`, run `node e2e/management-agent-contract.mjs` for actual host OS
confirmation. The runner imports the shipped CLI management-local entry, starts
real prepared-project daemons with an empty file tracker, and syncs stop targets
to a private journal before signaling. No tracker API or external credentials
are required. Docker uses the existing per-checkout Compose isolation.

| Case                                   | Expected evidence                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CP-01: identity scope                  | Two independent enrolled registries share a folder/local ID while retaining distinct environment identities; fleet routing remains a server contract   |
| CP-02/03: prepared and invalid folders | Canonical/symlink deduplication, second agent lock refused, invalid start rejected                                                                     |
| CP-02/04: exclusivity                  | Duplicate adapter starts retain one PID; independent local CLI cannot acquire its folder lock                                                          |
| CP-03/08: verified stop                | Invalid workflow remains stoppable; success requires exit and released locks; saved target recovery is idempotent                                      |
| CP-08: replacement                     | Restart preserves alias runtime ID; saved A target cannot stop B or change B ownership records                                                         |
| CP-15: local privacy                   | Inventory excludes prompts/raw identity; independent executable boundary captures the real CLI child environment excludes management credential canary |
| CP-14: removal/restart                 | Removing registration revokes effects; closing/reopening agent registry preserves the managed process                                                  |

Fault probes set `MANAGEMENT_AGENT_PLANT_FORBIDDEN` to `identity`, `canonical`, `locks`,
`replacement`, `credential`, or `continuity`. Each independently changes actual
filesystem/process conditions: collapse two environment identities, retarget a registered alias, leave a stop lock,
delete B's PID record, omit the supplied credential filter to leak an inherited environment value, or
stop the process after removal. The Compose runner requires each run to fail at
its named assertion; the ordinary run must reach all case markers first.

Cleanup stops only the fixture's verified target and removes its private tree.
Native systemd/launchd service isolation is a later slice: these tests establish
local process/registry independence, not service uninstall/restart guarantees.
CP-05–07/09–13/16–23 concern server, transport, command claims, reads and native
packaging outside C03; their typed protocol/native launcher boundaries remain
explicit. The upstream Symphony spec is unchanged.

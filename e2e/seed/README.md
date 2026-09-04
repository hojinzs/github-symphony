# E2E Seed Files

The Docker runners do not copy `config.json` into runtime state. They use
`/e2e/repos/test-owner/test-repo` as the local seed repository for
folder-addressed project tests.

`config.json` is kept as a reference snapshot for the project shape that the
E2E harness is expected to start.

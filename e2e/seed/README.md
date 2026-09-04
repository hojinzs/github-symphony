# E2E Seed Files

The Docker golden path does not copy `config.json` into the runtime. The
entrypoint clones `/e2e/repos/test-owner/test-repo`, changes into the cloned
repository, then starts `project start --project-dir /e2e/work/test-repo`.

`config.json` is kept as a reference snapshot for the single-repository
standalone project shape that the E2E harness is expected to start.

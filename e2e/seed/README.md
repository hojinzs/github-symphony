# E2E Seed Files

The Docker golden path does not copy `config.json` into the runtime. The
entrypoint clones `/e2e/repos/test-owner/test-repo`, changes into the cloned
repo, runs `repo init`, then starts `repo start`.

`config.json` is kept as a reference snapshot for the single-repository
project shape that `repo init` is expected to generate in E2E.

# Flat tracker-key removal

## Purpose

Verify the packaged CLI rejects a workflow that uses a removed flat tracker
key, while the Docker fixture itself continues to run with provider-form
configuration.

## Steps

1. Run `./e2e/run-flat-tracker-keys-e2e.sh`.
2. The runner starts the Docker E2E image and creates a temporary workflow
   with `tracker.kind: github-project` and a flat `tracker.project_id`.
3. It runs `node /app/packages/cli/dist/index.js workflow validate --file <path> --json`.

## Expected results

- `workflow validate` exits non-zero and emits the typed
  `workflow_deprecated_key` error at `tracker.project_id` with a
  `tracker.provider` migration instruction.
- Doctor behavior is verified by its isolated CLI suite, including the
  copyable normalized `tracker.provider` block.
- The normal provider-form Docker seed continues through the `happy` worker
  lifecycle.

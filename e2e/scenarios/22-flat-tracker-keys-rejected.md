# Flat tracker-key removal

## Purpose

Verify the packaged CLI rejects a workflow that uses a removed flat tracker
key, while the Docker fixture itself continues to run with provider-form
configuration.

## Steps

1. Start the Docker E2E environment with the normal `happy` scenario.
2. In the container, create a temporary `WORKFLOW.md` that has
   `tracker.kind: github-project` and a flat `tracker.project_id`.
3. Run `node /app/packages/cli/dist/index.js workflow validate --file <path>`.
4. Run `node /app/packages/cli/dist/index.js doctor` against the same
   workflow when it is selected as the project workflow.

## Expected results

- `workflow validate` exits non-zero and emits the typed
  `workflow_deprecated_key` error at `tracker.project_id` with a
  `tracker.provider` migration instruction.
- Doctor marks the workflow invalid and includes a copyable normalized
  `tracker.provider` block.
- The normal provider-form Docker seed continues through the `happy` worker
  lifecycle.

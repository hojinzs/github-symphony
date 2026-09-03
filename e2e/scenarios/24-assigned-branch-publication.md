# TC-24: Agent-triggered assigned-branch publication

## Purpose

Verify that a running worker can publish its assigned branch through the
authenticated host action and observe the remote ref before worker exit.

## Procedure

1. Start the Docker E2E stack with `STUB_SCENARIO=assigned-branch-publish`.
   The runner permits updates to the fixture's checked-out ref because its
   local clone source is non-bare; production assigned feature branches do not
   need this fixture-only setting.
2. Let the stub worker create and commit a file on its assigned branch.
3. Request `POST /api/v1/assigned-branch/publish` twice with the run-scoped
   headers.
4. Require both responses to report the assigned branch and committed HEAD.
5. Resolve the assigned remote ref from inside the still-running worker.
6. Complete the tracker lifecycle and worker normally.

## Expected result

- Both publication requests succeed, proving the action is idempotent.
- The remote assigned-branch ref equals local HEAD before worker exit.
- The run completes without relying on the exit publication backstop.

## Command

```bash
./e2e/run-e2e.sh assigned-branch-publish 60
```

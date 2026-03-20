# PR #92 Review: fix(worker): handle turn failed and cancelled events

## Summary

This PR adds explicit handling for `turn/failed` and `turn/cancelled` protocol events in the worker's Codex client. Previously these events were unhandled, causing the worker to wait until timeout. Now they are treated as immediate terminal failures with proper error context propagation.

## Verdict: Approve with minor suggestions

The implementation is well-structured and correctly addresses the gap. The changes follow existing patterns in the codebase and the test coverage is thorough.

---

## Detailed Review

### Architecture & Design (Good)

1. **Correct layer placement** — All changes are within the Execution layer (worker), which is the right place for protocol-level failure handling.
2. **Terminal phase preservation** — The `preservesTerminalPhase` logic in the child exit handler correctly prevents the process exit from overwriting error details set by `turn/failed` or `turn/cancelled`. This is the key insight of the PR.
3. **Separation of concerns** — `describeTurnTerminalEvent` extracts error messages from arbitrary payload shapes, `markTurnTerminalFailure` handles state transitions, and `resolvePendingTurnCompletion` is extracted as a reusable helper. Clean factoring.

### Implementation (Good, minor issues)

4. **`turn/cancelled` → `canceled_by_reconciliation` mapping** — This maps all cancellations to `canceled_by_reconciliation`, which is the only cancellation-related `RunAttemptPhase`. This is correct given the current phase enum, but worth noting that if other cancellation reasons emerge (e.g., user-initiated cancel), this mapping may need revisiting.

5. **`describeTurnTerminalEvent` return type** — The function is typed as returning `string | null`, but it can never actually return `null`. Every code path returns a string (either extracted from params or the fallback). Consider tightening the return type to `string`. This would also simplify the `markTurnTerminalFailure` signature since `lastError` could be non-nullable.

6. **Exit handler `preservesTerminalPhase` condition** — The logic:
   ```typescript
   const preservesTerminalPhase =
     currentRunPhase != null && nextRunPhase === currentRunPhase;
   ```
   This works because `resolveExitRunPhase` returns the current phase unchanged when it's terminal. However, the condition `nextRunPhase === currentRunPhase` is technically true whenever the phase doesn't change, not just for terminal phases. If `resolveExitRunPhase` ever returns the same non-terminal phase (which it currently can't), this would incorrectly skip the status update. The logic is safe today but could be made more explicit by checking `TERMINAL_RUN_PHASES.has(currentRunPhase)` directly.

7. **Loop exit ordering** — The `turnTerminalFailurePhase` check is placed after `userInputRequired` but before `maxTurns`, which is correct:
   ```typescript
   if (userInputRequired) break;
   if (turnTerminalFailurePhase) break;
   if (turn + 1 >= maxTurns) break;
   ```

8. **Final status determination** — When `turnTerminalFailurePhase` is set, the final `runPhase` is assigned to the failure phase value itself (e.g., `"failed"` or `"canceled_by_reconciliation"`), which is correct. The intermediate `runtimeState.runPhase = "finishing"` on the line above is immediately overwritten — this is harmless but technically unnecessary when a terminal failure occurred.

### Tests (Good)

9. **Test coverage is comprehensive:**
   - `turn/failed` stops the loop immediately
   - `turn/cancelled` stops the loop immediately
   - Turn completion promise resolves (doesn't hang) on failure events
   - Nested error message extraction with whitespace fallback
   - Terminal failure details survive child process exit
   - Existing tests updated with `turnTerminalFailure` break checks

10. **Test replication approach** — The tests replicate protocol logic from `index.ts` rather than importing it directly (since the functions aren't exported). The new `applyChildExit`, `finalizeRunState`, and `markTurnTerminalFailure` test helpers mirror the production code accurately. This is a pragmatic approach given the module's top-level side effects, but means the test copies could drift from the source. Consider adding a code comment in `index.ts` referencing the test file to remind future maintainers to keep them in sync.

### E2E Scenario Doc

11. **`06-worker-failure-lifecycle-regression.md`** — Good addition documenting the manual E2E test procedure. The `fail` scenario setup references `./e2e/run-e2e.sh fail 30` — verify this script and scenario exist and work as documented.

---

## Specific Suggestions

### Suggestion 1: Tighten `describeTurnTerminalEvent` return type

```typescript
// Current:
function describeTurnTerminalEvent(
  event: "turn/failed" | "turn/cancelled",
  params: unknown
): string | null {

// Suggested:
function describeTurnTerminalEvent(
  event: "turn/failed" | "turn/cancelled",
  params: unknown
): string {
```

Every code path returns a non-null string. Making this explicit removes the need for `lastError: string | null` in `markTurnTerminalFailure`.

### Suggestion 2: Skip "finishing" assignment on terminal failure

```typescript
// Current (index.ts ~line 865):
runtimeState.runPhase = "finishing";
runtimeState.status =
  userInputRequired || turnTerminalFailurePhase ? "failed" : "completed";
runtimeState.runPhase = userInputRequired
  ? "failed"
  : turnTerminalFailurePhase ?? "succeeded";

// Suggested:
if (!turnTerminalFailurePhase) {
  runtimeState.runPhase = "finishing";
}
runtimeState.status =
  userInputRequired || turnTerminalFailurePhase ? "failed" : "completed";
runtimeState.runPhase = userInputRequired
  ? "failed"
  : turnTerminalFailurePhase ?? "succeeded";
```

This avoids the unnecessary intermediate state transition.

---

## Checklist

- [x] Changes are in the correct layer (Execution)
- [x] No modifications to `symphony-spec.md`
- [x] TypeScript strict mode maintained
- [x] Unit tests cover new behavior
- [x] Existing tests updated for new state
- [x] Error messages are descriptive and categorized
- [x] `RunAttemptPhase` enum values used correctly
- [x] No security concerns (no user input in shell commands, no injection vectors)

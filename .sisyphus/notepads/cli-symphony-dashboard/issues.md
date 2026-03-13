# Issues — cli-symphony-dashboard

## 2026-03-13 Known Issues / Gotchas

### status.ts noColor pattern

- status.ts does NOT have a global noColor state — uses local apply() wrapper per render call
- start.ts HAS a module-level `let noColor = false`, updated from options
- When extracting to ansi.ts, we need a global setNoColor()/getNoColor() pattern
- status.ts currently calls `const apply = noColor ? stripAnsi : id` pattern inline

### ANSI Prefix Difference

- start.ts: ESC = "\x1b[" so bold = ESC + "1m" + s + ESC + "0m"
- status.ts: uses "\x1b[1m" etc directly (no ESC const)
- Standardize to ESC const in ansi.ts

### runtimeSession field in activeRuns

- snapshot-builder.ts line 62: `runtimeSession: run.runtimeSession ?? null`
- But TenantStatusSnapshot.activeRuns[] type (lines 110-117) does NOT include runtimeSession
- This means there's already a mismatch that we don't need to fix (just preserve existing behavior)

### Missing export audit needed

- Need to verify core barrel exports include status-surface types before Task 4
- Task 3 handles this

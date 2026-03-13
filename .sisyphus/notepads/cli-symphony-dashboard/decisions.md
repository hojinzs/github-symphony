# Decisions — cli-symphony-dashboard

## 2026-03-13 Architectural Decisions (from Plan)

### ANSI Module Design

- Use `ESC = "\x1b["` constant (not raw strings)
- Export named functions: bold, dim, green, red, yellow, cyan, magenta, blue
- Global noColor state via setNoColor()/getNoColor() module functions
- Terminal helpers: clearScreen(), hideCursor(), showCursor()
- stripAnsi() for removing escape codes

### Worker Polling Strategy

- Option B: Worker → Orchestrator via live polling (spec-aligned)
- Dashboard polls worker /api/v1/state every 2s independently
- Orchestrator reconcileRun() enriches running records with live data
- Fetch timeout: AbortSignal.timeout(2000) - prevent blocking orchestrator tick
- Use Promise.allSettled() for parallel worker polls

### Status Watch Mode Architecture

- Non-TTY: JSON output (fallback to --json behavior)
- TTY: Full-screen clear-and-redraw (ESC[2J + ESC[H)
- SIGWINCH: Update terminalWidth for next render cycle
- SIGINT/SIGTERM: showCursor() + newline + exit
- Dashboard refresh: every 2s (independent of orchestrator tick 30s)

### renderer.ts Design

- Pure function: (TenantStatusSnapshot[], DashboardOptions) => string
- Import ANSI helpers from ../ansi.js
- Column widths: ID=8, STAGE=14, PID=8, AGE/TURN=12, TOKENS=10(right), SESSION=14, EVENT=dynamic
- Default terminal width: 115
- Row chrome: 4 chars (2 indent + 2 padding)

### Type Extension Strategy

- ALL new fields on existing types use ?: (optional)
- New LiveWorkerState type exported from core
- Backward compatibility: existing consumers unaffected

# Control Plane

The `control-plane` package provides the operator-facing HTTP surface for GitHub Symphony.
It serves both the JSON API (delegated to `@gh-symphony/dashboard`) and an HTML browser dashboard (React SPA).

---

## 1. Architecture

### 1.1 Position in the Monorepo

```
packages/
  control-plane/
    client/       ← React SPA (Vite)
    src/          ← Node.js HTTP server (tsup)
```

**Dependency graph:**

```
control-plane (server) → @gh-symphony/core, @gh-symphony/dashboard
control-plane (client) → React, TanStack Router, TanStack Query, Axios, Radix UI, Tailwind v4

cli → @gh-symphony/dashboard      (--http flag: JSON API only)
cli → @gh-symphony/control-plane  (--web flag:  JSON API + HTML dashboard)
```

`control-plane` has no dependency on `@gh-symphony/orchestrator`. The orchestrator's service instance is injected from `cli` via the `onRefreshRequest` callback.

### 1.2 Package Structure

```
packages/control-plane/
├── client/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── router.tsx               # TanStack Router instance
│   │   ├── routes/
│   │   │   ├── __root.tsx           # Root layout (nav, error boundary)
│   │   │   ├── index.tsx            # / → ProjectOverview
│   │   │   └── issues/
│   │   │       └── $identifier.tsx  # /issues/$identifier → IssueDetail
│   │   ├── components/              # Shared UI components (Radix UI + Tailwind)
│   │   ├── lib/
│   │   │   ├── api.ts               # Axios instance + typed API functions
│   │   │   └── query.ts             # QueryClient + query key factory
│   │   └── hooks/                   # Shared TanStack Query hooks
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── tsconfig.json
├── src/
│   ├── index.ts                     # Package public exports
│   └── server.ts                    # HTTP server (static + API delegation)
├── package.json
└── tsconfig.json
```

### 1.3 Request Routing (Node.js Server)

```
Incoming request
│
├── POST /api/v1/refresh     → onRefreshRequest() callback (injected by cli)
├── GET  /api/v1/state       → resolveDashboardResponse() (@gh-symphony/dashboard)
├── GET  /api/v1/:identifier → resolveDashboardResponse() (@gh-symphony/dashboard)
├── GET  /healthz            → { ok: true }
└── *                        → serve client/dist/index.html  (SPA fallback)
    └── static assets        → serve client/dist/*
```

### 1.4 Server Public API

```typescript
export interface ControlPlaneServerOptions {
  host: string;
  port: number;
  runtimeRoot: string;
  projectId: string;
  onRefreshRequest?: () => void;
}

export function startControlPlaneServer(
  options: ControlPlaneServerOptions
): Promise<{ server: Server; url: string; port: number }>;

export function createControlPlaneHandler(options: {
  reader: DashboardFsReader;
  onRefreshRequest?: () => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
```

Static assets are resolved relative to `import.meta.url`:

```typescript
const clientDist = join(dirname(fileURLToPath(import.meta.url)), "../client/dist");
```

---

## 2. Frontend Tech Stack

| Layer | Library | Version |
|-------|---------|---------|
| Framework | React | 19 |
| Routing | TanStack Router | latest (file-based, browser history, SPA) |
| Data fetching | TanStack Query + Axios | latest |
| UI primitives | Radix UI | latest |
| Styling | Tailwind CSS | v4 (CSS-first config) |
| Build | Vite | latest |

### 2.1 TanStack Router (File-Based)

`vite.config.ts` uses the `@tanstack/router-plugin/vite` plugin for automatic route generation from `client/src/routes/`.

```typescript
// vite.config.ts
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/api": "http://localhost:4680",
      "/healthz": "http://localhost:4680",
    },
  },
});
```

Route file conventions:

| File | Path | Page |
|------|------|------|
| `routes/__root.tsx` | (layout) | Root layout with nav bar |
| `routes/index.tsx` | `/` | Project overview |
| `routes/issues/$identifier.tsx` | `/issues/:identifier` | Issue detail |

The SPA fallback on the Node.js server ensures any deep link (e.g., `/issues/gh-symphony%23174`) is handled by React Router client-side.

### 2.2 Data Fetching (Axios + TanStack Query)

Axios instance is created once in `lib/api.ts` with a base URL of `/` (same origin in production, proxied in dev).

Query key factory in `lib/query.ts`:

```typescript
export const queryKeys = {
  projectState: () => ["project", "state"] as const,
  issueDetail: (identifier: string) => ["issue", identifier] as const,
};
```

Query hooks:

```typescript
// hooks/useProjectState.ts
export function useProjectState() {
  return useQuery({
    queryKey: queryKeys.projectState(),
    queryFn: () => api.get<ProjectState>("/api/v1/state").then(r => r.data),
    refetchInterval: 30_000,
  });
}

// hooks/useIssueDetail.ts
export function useIssueDetail(identifier: string) {
  return useQuery({
    queryKey: queryKeys.issueDetail(identifier),
    queryFn: () => api.get<IssueStatus>(`/api/v1/${encodeURIComponent(identifier)}`).then(r => r.data),
    refetchInterval: 10_000,
  });
}

// hooks/useRefresh.ts
export function useRefresh() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/api/v1/refresh"),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
```

---

## 3. Pages and Features

### 3.1 Project Overview (`/`)

**Data source:** `GET /api/v1/state`

**Key information displayed:**

- Project name, health status badge
- Summary counters: active runs, total dispatched, retry queue length
- Active runs table: issue identifier, state, status, started at, last event
- Retry queue table: issue identifier, retry due at, error message
- Last error (if any)
- Last tick timestamp
- Completed issues count

**UX:**
- Auto-refresh every 30 seconds (TanStack Query `refetchInterval`)
- Manual refresh button → `POST /api/v1/refresh` then invalidate all queries
- Issue identifiers in active runs link to `/issues/:identifier`

### 3.2 Issue Detail (`/issues/:identifier`)

**Data source:** `GET /api/v1/:identifier`

**Key information displayed:**

- Issue identifier, current status badge
- Orchestration state (`claimed` / `released`)
- Current run phase and execution phase
- Attempt counter (current attempt, restart count)
- Workspace path
- Token usage (current run + cumulative)
- Retry info (due at, kind, error)
- Recent events list (timestamp + message)
- Links to worker log path
- Last error

**UX:**
- Auto-refresh every 10 seconds
- Back link to `/`
- Manual refresh button

---

## 4. Build Pipeline

### 4.1 Scripts

```json
{
  "scripts": {
    "build": "pnpm build:client && pnpm build:server",
    "build:client": "vite build --config client/vite.config.ts",
    "build:server": "tsup src/index.ts --format esm --dts",
    "dev:client": "vite --config client/vite.config.ts",
    "dev:server": "tsup src/index.ts --watch --format esm",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p client/tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  }
}
```

### 4.2 Output

| Output | Contents | Purpose |
|--------|----------|---------|
| `client/dist/` | Vite-bundled React app | Served as static assets |
| `dist/` | tsup-compiled Node.js server | npm package entry |

Both directories are included in `files` in `package.json`.

### 4.3 Development Workflow

```bash
# Terminal 1: API server on :4680 (watches src/)
pnpm --filter @gh-symphony/control-plane dev:server

# Terminal 2: Vite dev server on :5173 (proxies /api → :4680)
pnpm --filter @gh-symphony/control-plane dev:client
```

During development, the React app is served by Vite on `:5173`. API calls are proxied to the Node.js server on `:4680`. The `gh-symphony project start --web` command starts only the Node.js server; point a browser at `:5173` during dev, `:4680` in production.

---

## 5. CLI Integration

The `--web` flag is added to `gh-symphony start` (and `gh-symphony project start`):

```bash
gh-symphony project start --web          # orchestrator + HTML dashboard
gh-symphony project start --web 4680     # explicit port
gh-symphony project start --http         # orchestrator + JSON API only (existing)
```

In `packages/cli/src/commands/start.ts`:

```typescript
import { startControlPlaneServer } from "@gh-symphony/control-plane";

if (parsed.web !== undefined) {
  httpServer = await startControlPlaneServer({
    host: HTTP_HOST,
    port: parsed.web ?? DEFAULT_HTTP_PORT,
    runtimeRoot,
    projectId,
    onRefreshRequest: () => service.requestReconcile(),
  });
  logLine(cyan("□"), `Web dashboard: ${httpServer.url}`);
}
```

The `--http` flag and its existing inline server remain unchanged for backward compatibility.

---

## 6. Design Requirements

### 6.1 Visual Design

- Dark mode by default (operator tooling context)
- Minimal, information-dense layout — no decorative elements
- Status badges use semantic color: green (running/completed), yellow (retry/degraded), red (failed/error), gray (idle/stopped)
- Monospace font for identifiers, paths, session IDs, timestamps
- Responsive down to 1024px minimum width (terminal-adjacent tooling, not mobile)

### 6.2 Component Guidelines (Radix UI)

| UI Element | Radix Primitive |
|------------|----------------|
| Status badge | `Badge` |
| Data tables | `Table` |
| Error message | `Callout` |
| Refresh button | `Button` |
| Navigation | custom (minimal) |
| Loading state | `Skeleton` |
| Tooltip (timestamps) | `Tooltip` |

### 6.3 Performance

- Bundle size: keep under 200KB gzipped. Radix UI is tree-shakable; import only used primitives.
- No SSR required — static SPA served from `client/dist/`
- All data fetching is client-side via TanStack Query

### 6.4 Error Handling

- API errors surface via TanStack Query `isError` state
- 404 on issue detail → show "Issue not found" message with back link
- Network failure → show stale data indicator + last successful fetch timestamp
- No unhandled promise rejections; all query errors are caught by TanStack Query

### 6.5 Accessibility

- Keyboard-navigable (Radix UI handles focus management)
- ARIA labels on status badges and icon-only buttons
- Sufficient color contrast in dark mode (WCAG AA)

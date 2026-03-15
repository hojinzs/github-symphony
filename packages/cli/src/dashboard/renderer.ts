// ── Dashboard Renderer (Elixir-parity) ──────────────────────────────────────

import {
  bold,
  dim,
  green,
  red,
  yellow,
  cyan,
  magenta,
  blue,
  stripAnsi,
} from "../ansi.js";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";

// ── Public types ─────────────────────────────────────────────────────────────

export type DashboardOptions = {
  terminalWidth: number;
  noColor: boolean;
  maxAgents?: number;
  /** Override Date.now() for deterministic testing */
  now?: number;
};

// ── Internal types ───────────────────────────────────────────────────────────

/** Active run plus CLI-only runtime session decoration */
type ActiveRunView = ProjectStatusSnapshot["activeRuns"][number] & {
  runtimeSession?: {
    sessionId: string | null;
    threadId: string | null;
  } | null;
};

type ColorFn = (s: string) => string;
type Colors = {
  bold: ColorFn;
  dim: ColorFn;
  green: ColorFn;
  red: ColorFn;
  yellow: ColorFn;
  cyan: ColorFn;
  magenta: ColorFn;
  blue: ColorFn;
};

// ── Column widths (from Elixir spec) ─────────────────────────────────────────

const COL_ID = 24;
const COL_STATUS = 14;
const COL_PID = 8;
const COL_AGE_TURN = 12;
const COL_TOKENS = 10;
const COL_SESSION = 14;
/** ID header width accounts for "● " prefix in data rows */
const COL_ID_HEADER = COL_ID + 2;

// ── Helpers ──────────────────────────────────────────────────────────────────

const identity = (s: string): string => s;

function makeColors(noColor: boolean): Colors {
  if (noColor) {
    return {
      bold: identity,
      dim: identity,
      green: identity,
      red: identity,
      yellow: identity,
      cyan: identity,
      magenta: identity,
      blue: identity,
    };
  }
  return { bold, dim, green, red, yellow, cyan, magenta, blue };
}

function pad(
  s: string,
  width: number,
  align: "left" | "right" = "left"
): string {
  const visible = stripAnsi(s);
  if (visible.length >= width) return visible.slice(0, width);
  const padding = " ".repeat(width - visible.length);
  return align === "right" ? padding + s : s + padding;
}

function compactSessionId(id: string | null | undefined): string {
  if (!id) return "\u2014";
  if (id.length <= 10) return id;
  return `${id.slice(0, 4)}...${id.slice(-6)}`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtAge(startedAt: string | null | undefined, now: number): string {
  if (!startedAt) return "0m";
  const diffMs = now - new Date(startedAt).getTime();
  if (diffMs < 0) return "0m";
  const totalMin = Math.floor(diffMs / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function fmtRuntime(ms: number): string {
  if (ms <= 0) return "0h 0m";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function fmtRetryTime(nextRetryAt: string | null, now: number): string {
  if (!nextRetryAt) return "\u2014";
  const diffMs = new Date(nextRetryAt).getTime() - now;
  if (diffMs <= 0) return "now";
  const totalSec = Math.ceil(diffMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const COL_SEPARATORS = 6;

function eventColWidth(termWidth: number): number {
  const fixed =
    2 +
    COL_ID_HEADER +
    COL_STATUS +
    COL_PID +
    COL_AGE_TURN +
    COL_TOKENS +
    COL_SESSION +
    COL_SEPARATORS;
  return Math.max(5, termWidth - fixed);
}

// ── Status dot ───────────────────────────────────────────────────────────────

function statusDot(run: ActiveRunView, c: Colors): string {
  const event = run.lastEvent;
  if (event === null || event === undefined || run.status === "failed")
    return c.red("\u25CF");
  if (event === "token_count") return c.yellow("\u25CF");
  if (event === "task_started") return c.green("\u25CF");
  if (event === "turn_completed") return c.magenta("\u25CF");
  return c.blue("\u25CF");
}

// ── Section builders ─────────────────────────────────────────────────────────

function titleBar(width: number, c: Colors): string {
  const title = " gh-symphony ";
  const side = Math.max(0, Math.floor((width - title.length) / 2));
  const right = Math.max(0, width - side - title.length);
  return c.bold("\u2550".repeat(side) + title + "\u2550".repeat(right));
}

function sectionDivider(label: string, width: number, c: Colors): string {
  const prefix = `\u2500\u2500 ${label} `;
  const fill = "\u2500".repeat(Math.max(0, width - prefix.length));
  return c.dim(prefix + fill);
}

function buildSummaryLines(
  snapshots: ProjectStatusSnapshot[],
  options: DashboardOptions,
  c: Colors
): string[] {
  const now = options.now ?? Date.now();
  const lines: string[] = [];

  const totalActive = snapshots.reduce(
    (sum, s) => sum + s.summary.activeRuns,
    0
  );
  const agentStr =
    options.maxAgents != null
      ? `${totalActive}/${options.maxAgents}`
      : `${totalActive}`;

  const totIn = snapshots.reduce(
    (sum, s) => sum + (s.codexTotals?.inputTokens ?? 0),
    0
  );
  const totOut = snapshots.reduce(
    (sum, s) => sum + (s.codexTotals?.outputTokens ?? 0),
    0
  );
  const totAll = snapshots.reduce(
    (sum, s) => sum + (s.codexTotals?.totalTokens ?? 0),
    0
  );

  const allStarts = snapshots
    .flatMap((s) => s.activeRuns)
    .map((r) => r.startedAt)
    .filter((t): t is string => t != null)
    .map((t) => new Date(t).getTime());
  const runtimeMs = allStarts.length > 0 ? now - Math.min(...allStarts) : 0;
  const runtime = fmtRuntime(runtimeMs);

  lines.push(
    `  ${c.dim("Agents")}  ${c.bold(agentStr)}     ${c.dim("Runtime")}  ${c.bold(runtime)}    ${c.dim("Tokens")}  ${fmtTokens(totIn)} in / ${fmtTokens(totOut)} out / ${c.bold(fmtTokens(totAll))} total`
  );

  const hasLimits = snapshots.some((s) => s.rateLimits != null);
  const limitStr = hasLimits ? "active" : "standard";
  lines.push(`  ${c.dim("Rate Limits")}  ${limitStr}`);

  return lines;
}

function tableHeaderRow(c: Colors): string {
  const cols = [
    pad("ID", COL_ID_HEADER),
    pad("STATUS", COL_STATUS),
    pad("PID", COL_PID),
    pad("AGE/TURN", COL_AGE_TURN),
    pad("TOKENS", COL_TOKENS),
    pad("SESSION", COL_SESSION),
    "EVENT",
  ].join(" ");
  return `  ${c.dim(cols)}`;
}

function activeRunRow(
  run: ActiveRunView,
  now: number,
  evtWidth: number,
  c: Colors
): string {
  const dot = statusDot(run, c);
  const id = pad(run.issueIdentifier, COL_ID);
  const status = pad(
    run.issueState ?? run.executionPhase ?? "\u2014",
    COL_STATUS
  );
  const pid = pad(
    run.processId != null ? String(run.processId) : "\u2014",
    COL_PID
  );
  const age = fmtAge(run.startedAt, now);
  const turn = run.turnCount ?? 0;
  const ageTurn = pad(`${age}/${turn}`, COL_AGE_TURN);
  const tokens = pad(
    fmtTokens(run.tokenUsage?.totalTokens ?? 0),
    COL_TOKENS,
    "right"
  );

  const sessionId =
    run.runtimeSession?.sessionId ?? run.runtimeSession?.threadId ?? null;
  const session = pad(compactSessionId(sessionId), COL_SESSION);

  const event = pad(run.lastEvent ?? "\u2014", evtWidth);

  const columns = [id, status, pid, ageTurn, tokens, session, event].join(" ");
  return `  ${dot} ${columns}`;
}

function retryRow(
  entry: ProjectStatusSnapshot["retryQueue"][number],
  snapshot: ProjectStatusSnapshot,
  now: number,
  c: Colors
): string {
  const id = entry.issueIdentifier;
  const kind = entry.retryKind;
  const timeStr = fmtRetryTime(entry.nextRetryAt, now);

  const matchingRun = snapshot.activeRuns.find((r) => r.runId === entry.runId);
  const errorHint = matchingRun?.lastEvent ?? "";

  return `  ${c.yellow("\u21BB")} ${id}  ${kind}  retrying in ${timeStr}${errorHint ? "  " + errorHint : ""}`;
}

// ── Main Renderer ────────────────────────────────────────────────────────────

export function renderDashboard(
  snapshots: ProjectStatusSnapshot[],
  options: DashboardOptions
): string {
  const width = options.terminalWidth || 115;
  const now = options.now ?? Date.now();
  const c = makeColors(options.noColor);
  const evtWidth = eventColWidth(width);

  const lines: string[] = [];

  lines.push(titleBar(width, c));
  lines.push(...buildSummaryLines(snapshots, options, c));
  lines.push("");

  for (const snap of snapshots) {
    const hasActiveRuns = snap.activeRuns.length > 0;
    const hasRetries = snap.retryQueue.length > 0;
    if (!hasActiveRuns && !hasRetries) continue;

    lines.push(sectionDivider(snap.slug, width, c));
    if (hasActiveRuns) {
      lines.push(tableHeaderRow(c));
      for (const rawRun of snap.activeRuns) {
        const run = rawRun as ActiveRunView;
        lines.push(activeRunRow(run, now, evtWidth, c));
      }
    }
    lines.push("");
  }

  const allRetries: Array<{
    entry: ProjectStatusSnapshot["retryQueue"][number];
    snapshot: ProjectStatusSnapshot;
  }> = [];
  for (const snap of snapshots) {
    for (const entry of snap.retryQueue) {
      allRetries.push({ entry, snapshot: snap });
    }
  }
  if (allRetries.length > 0) {
    lines.push(sectionDivider("Backoff Queue", width, c));
    for (const { entry, snapshot } of allRetries) {
      lines.push(retryRow(entry, snapshot, now, c));
    }
    lines.push("");
  }

  const result = lines.map((line) => {
    const visible = stripAnsi(line);
    if (visible.length <= width) return line;
    return visible.slice(0, width);
  });

  return result.join("\n");
}

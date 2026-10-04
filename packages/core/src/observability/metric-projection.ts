import type {
  OrchestratorRunRecord,
  ProjectStatusSnapshot,
} from "../contracts/status-surface.js";
import { aggregateTokenUsage } from "./run-accounting.js";

export type ProjectMetricProjection = Readonly<{
  sourceTime: string;
  activeRuns: number;
  retryingRuns: number;
  health: Readonly<Record<"idle" | "running" | "degraded", 0 | 1>>;
  pollIntervalMs?: number;
  /** A committed tick's decisions, not retained-history counters. */
  tickOutcomes: Readonly<
    Record<"dispatched" | "suppressed" | "recovered" | "skipped", number>
  >;
  /** Adapter capability, independent of whether a measurement exists. */
  tokensSupported: Readonly<Record<"codex" | "claude", 0 | 1>>;
  /** Null means no measured Codex data; measured zero remains a numeric zero. */
  tokenTotals: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }> | null;
  /** All retained runtime lifecycles, including live elapsed at sourceTime. */
  runtimeSeconds: number;
}>;

/**
 * SDK-free catalog inputs for one committed snapshot and its retained runs.
 * Callers supply the same run set used to build the snapshot (allRuns when
 * available, otherwise activeRuns). This reads no files or tracker state and
 * advances no counters. Repeated projection/collection is accounting-neutral.
 */
export function buildProjectMetricProjection(
  snapshot: Readonly<ProjectStatusSnapshot>,
  runs: readonly OrchestratorRunRecord[]
): ProjectMetricProjection {
  const measuredRuns = runs.filter(
    (run) =>
      run.runtimeKind === "codex-app-server" &&
      run.tokenUsageMeasured === true &&
      run.tokenUsage !== undefined
  );
  const totals = aggregateTokenUsage(measuredRuns, snapshot.lastTickAt);
  return Object.freeze({
    sourceTime: snapshot.lastTickAt,
    activeRuns: snapshot.summary.activeRuns,
    retryingRuns: snapshot.retryQueue.length,
    health: Object.freeze({
      idle: snapshot.health === "idle" ? 1 : 0,
      running: snapshot.health === "running" ? 1 : 0,
      degraded: snapshot.health === "degraded" ? 1 : 0,
    }),
    ...(snapshot.effectivePollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: snapshot.effectivePollIntervalMs }),
    tickOutcomes: Object.freeze({
      dispatched: snapshot.summary.dispatched,
      suppressed: snapshot.summary.suppressed,
      recovered: snapshot.summary.recovered,
      skipped: snapshot.summary.skipped ?? 0,
    }),
    tokensSupported: Object.freeze({ codex: 1, claude: 0 }),
    tokenTotals:
      measuredRuns.length === 0
        ? null
        : Object.freeze({
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.totalTokens,
          }),
    runtimeSeconds:
      snapshot.codexTotals?.secondsRunning ??
      aggregateTokenUsage(runs, snapshot.lastTickAt).secondsRunning,
  });
}

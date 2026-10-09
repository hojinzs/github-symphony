import { ROOT_CONTEXT } from "@opentelemetry/api";
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import type {
  CommittedMetricSnapshot,
  ProjectMetricProjection,
  TickMeasurement,
} from "@gh-symphony/core";
import {
  createProjectResource,
  type ProjectResourceIdentity,
} from "./resource.js";

export const METRIC_CATALOG = {
  active: { name: "symphony.runs.active", unit: "{run}" },
  retrying: { name: "symphony.runs.retrying", unit: "{run}" },
  health: { name: "symphony.health", unit: "1" },
  poll: { name: "symphony.poll.interval", unit: "ms" },
  outcomes: { name: "symphony.tick.outcomes", unit: "{decision}" },
  tokens: { name: "symphony.tokens.total", unit: "{token}" },
  supported: { name: "symphony.tokens.supported", unit: "1" },
  runtime: { name: "symphony.runtime.total", unit: "s" },
  duration: { name: "symphony.tick.duration", unit: "s" },
  dropped: { name: "symphony.telemetry.dropped", unit: "{record}" },
} as const;
export const TICK_DURATION_BOUNDS = [
  0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120,
];
export type MetricLossReason =
  | "queue_full"
  | "timeout"
  | "permanent"
  | "shutdown"
  | "mapping"
  | "partial";
const lossReasons: readonly MetricLossReason[] = [
  "queue_full",
  "timeout",
  "permanent",
  "shutdown",
  "mapping",
  "partial",
];

/** Pull-only SDK reader: the adapter owns timing, concurrency and retries. */
export class CumulativeMetricReader extends MetricReader {
  constructor() {
    super({
      // Gauges have no wire temporality. DELTA clears unobserved series in the
      // JS SDK, preventing a retained value after measurement/history disappears.
      aggregationTemporalitySelector: (type) =>
        type === InstrumentType.OBSERVABLE_GAUGE
          ? AggregationTemporality.DELTA
          : AggregationTemporality.CUMULATIVE,
      cardinalitySelector: () => 32,
    });
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

/** Only committed offers advance counters. Collection reads one cached projection,
 * never the store, retained runs, tracker, or the snapshot builder.
 */
export function createOwnedMetricProvider(identity: ProjectResourceIdentity) {
  const resource = createProjectResource(identity);
  const reader = new CumulativeMetricReader();
  const provider = new MeterProvider({
    resource,
    readers: [reader],
    // SDK self-observability would add metrics outside the approved catalog.
    sdkMetricsEnabled: false,
    views: [
      {
        instrumentName: METRIC_CATALOG.duration.name,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: TICK_DURATION_BOUNDS },
        },
      },
    ],
  });
  const meter = provider.getMeter("gh-symphony.orchestrator", identity.version);
  const gauges = Object.fromEntries(
    (
      [
        "active",
        "retrying",
        "health",
        "poll",
        "tokens",
        "supported",
        "runtime",
      ] as const
    ).map((key) => [
      key,
      meter.createObservableGauge(METRIC_CATALOG[key].name, {
        unit: METRIC_CATALOG[key].unit,
      }),
    ])
  );
  const outcomes = meter.createCounter(METRIC_CATALOG.outcomes.name, {
    unit: METRIC_CATALOG.outcomes.unit,
  });
  const duration = meter.createHistogram(METRIC_CATALOG.duration.name, {
    unit: METRIC_CATALOG.duration.unit,
  });
  const dropped = meter.createCounter(METRIC_CATALOG.dropped.name, {
    unit: METRIC_CATALOG.dropped.unit,
  });
  let latest: ProjectMetricProjection | undefined;
  let instanceId: string | undefined;
  let sequence = 0;
  let stopped = false;
  meter.addBatchObservableCallback((result) => {
    const p = latest;
    if (!p) return;
    result.observe(gauges.active!, p.activeRuns);
    result.observe(gauges.retrying!, p.retryingRuns);
    for (const state of ["idle", "running", "degraded"] as const)
      result.observe(gauges.health!, p.health[state], { state });
    if (p.pollIntervalMs !== undefined)
      result.observe(gauges.poll!, p.pollIntervalMs);
    for (const runtime of ["codex", "claude"] as const)
      result.observe(gauges.supported!, p.tokensSupported[runtime], {
        runtime,
      });
    if (p.tokenTotals) {
      for (const [direction, value] of [
        ["input", p.tokenTotals.inputTokens],
        ["output", p.tokenTotals.outputTokens],
        ["total", p.tokenTotals.totalTokens],
      ] as const)
        result.observe(gauges.tokens!, value, { direction, runtime: "codex" });
    }
    result.observe(gauges.runtime!, p.runtimeSeconds);
  }, Object.values(gauges));
  return {
    resource,
    provider,
    reader,
    offerSnapshot(snapshot: CommittedMetricSnapshot): void {
      if (
        stopped ||
        snapshot.projectId !== identity.projectId ||
        (instanceId !== undefined && snapshot.instanceId !== instanceId) ||
        !Number.isSafeInteger(snapshot.sequence) ||
        snapshot.sequence <= sequence
      )
        return;
      const p = snapshot.projection;
      // Copy only catalog fields; callers cannot mutate or inject metric labels.
      latest = Object.freeze({
        sourceTime: p.sourceTime,
        activeRuns: p.activeRuns,
        retryingRuns: p.retryingRuns,
        health: Object.freeze({
          idle: p.health.idle,
          running: p.health.running,
          degraded: p.health.degraded,
        }),
        pollIntervalMs: p.pollIntervalMs,
        tickOutcomes: Object.freeze({
          dispatched: p.tickOutcomes.dispatched,
          suppressed: p.tickOutcomes.suppressed,
          recovered: p.tickOutcomes.recovered,
          skipped: p.tickOutcomes.skipped,
        }),
        tokensSupported: Object.freeze({ codex: 1, claude: 0 }),
        tokenTotals:
          p.tokenTotals === null
            ? null
            : Object.freeze({
                inputTokens: p.tokenTotals.inputTokens,
                outputTokens: p.tokenTotals.outputTokens,
                totalTokens: p.tokenTotals.totalTokens,
              }),
        runtimeSeconds: p.runtimeSeconds,
      });
      instanceId = snapshot.instanceId;
      sequence = snapshot.sequence;
      for (const outcome of [
        "dispatched",
        "suppressed",
        "recovered",
        "skipped",
      ] as const)
        outcomes.add(latest.tickOutcomes[outcome], { outcome }, ROOT_CONTEXT);
    },
    observeTick(measurement: TickMeasurement): void {
      if (
        !stopped &&
        ["success", "failure"].includes(measurement.outcome) &&
        Number.isFinite(measurement.durationSeconds) &&
        measurement.durationSeconds >= 0
      )
        duration.record(
          measurement.durationSeconds,
          { outcome: measurement.outcome },
          ROOT_CONTEXT
        );
    },
    recordLoss(
      signal: "logs" | "metrics",
      reason: MetricLossReason,
      count: number
    ): void {
      if (
        !stopped &&
        ["logs", "metrics"].includes(signal) &&
        lossReasons.includes(reason) &&
        Number.isSafeInteger(count) &&
        count > 0
      )
        dropped.add(count, { signal, reason }, ROOT_CONTEXT);
    },
    stop(): void {
      stopped = true;
    },
    status() {
      return { sequence, hasSnapshot: latest !== undefined };
    },
  };
}

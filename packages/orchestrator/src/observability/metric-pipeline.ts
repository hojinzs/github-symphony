import { ProtobufMetricsSerializer } from "@opentelemetry/otlp-transformer";
import { offerBestEffort } from "../publication.js";
import { createOwnedMetricProvider } from "./metric-provider.js";
import type { ProjectResourceIdentity } from "./resource.js";
import {
  exportMetricBatch,
  type LogDestination,
  type LogRequest,
} from "./transport.js";

export type MetricDiagnostic = Readonly<{
  signal: "metrics";
  state: "failure" | "recovery";
  reason:
    | "transport"
    | "timeout"
    | "permanent"
    | "partial"
    | "shutdown"
    | "mapping";
  lost: number;
}>;

/** One latest projection, one in-flight immutable batch, one pending collection.
 * Offers never start network work or collect; no SDK exporter/timer is layered
 * beneath this owner. Coalescing snapshots is sampling, not telemetry loss.
 */
export function createMetricPipeline(
  identity: ProjectResourceIdentity,
  destination: LogDestination,
  options: {
    request?: LogRequest;
    diagnostic?: (notice: MetricDiagnostic) => void;
  } = {}
) {
  const owned = createOwnedMetricProvider(identity);
  let active: Promise<void> | undefined;
  let pending = false;
  let stopped = false;
  let closing = false;
  let controller = new AbortController();
  let shutdownPromise: Promise<void> | undefined;
  const episodes = new Map<
    MetricDiagnostic["reason"],
    { at: number; pending: number }
  >();
  const diagnostic =
    options.diagnostic ??
    ((notice) => {
      process.stderr.write(
        `OTLP metrics ${notice.state}: ${notice.reason}; lost=${notice.lost}\n`
      );
    });
  const notify = (notice: MetricDiagnostic) =>
    offerBestEffort(() => diagnostic(Object.freeze(notice)));
  const warn = (reason: MetricDiagnostic["reason"], lost: number) => {
    const now = Date.now();
    const episode = episodes.get(reason);
    if (!episode) {
      episodes.set(reason, { at: now, pending: 0 });
      notify({ signal: "metrics", state: "failure", reason, lost });
      return;
    }
    episode.pending += lost;
    if (now - episode.at >= 60_000) {
      const summary = episode.pending;
      episode.pending = 0;
      episode.at = now;
      notify({ signal: "metrics", state: "failure", reason, lost: summary });
    }
  };
  const summarizePending = () => {
    for (const [reason, episode] of episodes) {
      if (!episode.pending) continue;
      notify({
        signal: "metrics",
        state: "failure",
        reason,
        lost: episode.pending,
      });
      episode.pending = 0;
    }
  };
  const recover = () => {
    // Final episode summaries preserve losses suppressed by the warning interval.
    summarizePending();
    for (const reason of episodes.keys())
      notify({ signal: "metrics", state: "recovery", reason, lost: 0 });
    episodes.clear();
  };
  const interval = setInterval(() => {
    void collect();
  }, 10_000);
  interval.unref();

  function collect(): Promise<void> {
    if (stopped) return Promise.resolve();
    pending = true;
    if (active) return active;
    // Start after the synchronous caller stack; concurrent requests coalesce.
    const operation = Promise.resolve().then(async () => {
      while (pending && !stopped) {
        pending = false;
        const signal = controller.signal;
        let count = 0;
        try {
          const { resourceMetrics, errors } = await owned.reader.collect();
          if (errors.length) throw new Error("Metric collection failed");
          count = resourceMetrics.scopeMetrics.reduce(
            (total, scope) =>
              total +
              scope.metrics.reduce(
                (sum, metric) => sum + metric.dataPoints.length,
                0
              ),
            0
          );
          if (!count) continue;
          const bytes =
            ProtobufMetricsSerializer.serializeRequest(resourceMetrics);
          if (!bytes) throw new Error("Metric serialization failed");
          const result = await exportMetricBatch(
            destination,
            bytes,
            count,
            signal,
            options.request,
            undefined,
            () => warn("transport", 0)
          );
          if (result.reason) {
            owned.recordLoss("metrics", result.reason, result.rejected);
            // Diagnostics do not trigger another collection, including a dropped
            // diagnostic point: the next regular collection sees the counter.
            warn(result.reason, result.rejected);
          } else {
            recover();
          }
        } catch {
          owned.recordLoss("metrics", "mapping", Math.max(count, 1));
          warn("mapping", Math.max(count, 1));
        }
      }
    });
    active = operation.finally(() => {
      active = undefined;
    });
    return active;
  }

  async function flush(deadline: number): Promise<void> {
    if (stopped) {
      await active;
      return;
    }
    const timeout = setTimeout(
      () => {
        pending = false;
        controller.abort();
      },
      Math.max(0, Math.min(5000, deadline - Date.now()))
    );
    try {
      await collect();
    } finally {
      clearTimeout(timeout);
      if (controller.signal.aborted && !stopped)
        controller = new AbortController();
    }
  }

  function shutdown(deadline: number): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    clearInterval(interval);
    shutdownPromise = (async () => {
      await flush(deadline);
      summarizePending();
      episodes.clear();
      stopped = true;
      pending = false;
      controller.abort();
      owned.stop();
      await owned.provider.shutdown();
    })();
    return shutdownPromise;
  }

  return {
    offerSnapshot(snapshot: Parameters<typeof owned.offerSnapshot>[0]): void {
      if (!closing) owned.offerSnapshot(snapshot);
    },
    observeTick(measurement: Parameters<typeof owned.observeTick>[0]): void {
      if (!closing) owned.observeTick(measurement);
    },
    recordLoss: owned.recordLoss,
    collect,
    flush,
    shutdown,
    status() {
      return { ...owned.status(), inFlight: active !== undefined, pending };
    },
  };
}

import { randomUUID } from "node:crypto";
import type { ResolvedOtlpConfiguration } from "@gh-symphony/core";
import type { ProjectResourceIdentity } from "./resource.js";
import { createLogPipeline } from "./log-pipeline.js";
import { createMetricPipeline } from "./metric-pipeline.js";
import type { TelemetryPipeline } from "./lifecycle.js";

/** Loaded only by an enabled, capability-approved owner, after child isolation
 * has been constructed. Both providers share resource identity and deadline.
 */
export function createProjectPipeline(
  identity: ProjectResourceIdentity,
  config: Readonly<ResolvedOtlpConfiguration>,
  options: {
    logs?: Parameters<typeof createLogPipeline>[2];
    metrics?: Parameters<typeof createMetricPipeline>[2];
  } = {}
): TelemetryPipeline {
  const resourceIdentity = {
    ...identity,
    instanceId: identity.instanceId ?? randomUUID(),
    attributes: { ...config.resourceAttributes },
  };
  const logs = createLogPipeline(resourceIdentity, config.logs!, options.logs);
  let metrics: ReturnType<typeof createMetricPipeline>;
  try {
    metrics = createMetricPipeline(resourceIdentity, config.metrics!, {
      ...options.metrics,
      logsStatus: logs.status,
    });
  } catch {
    void logs.shutdown(Date.now()).catch(() => {});
    throw new Error("OTLP provider construction failed");
  }
  return {
    offerEvent: logs.offerEvent,
    offerSnapshot: metrics.offerSnapshot,
    observeTick: metrics.observeTick,
    diagnostics: () => ({ logs: logs.status(), metrics: metrics.status() }),
    async shutdown(deadline) {
      await Promise.allSettled([
        logs.shutdown(deadline),
        metrics.shutdown(deadline),
      ]);
    },
  };
}

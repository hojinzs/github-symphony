import { ROOT_CONTEXT } from "@opentelemetry/api";
import {
  createProjectResource,
  type ProjectResourceIdentity,
} from "./resource.js";
export type { ProjectResourceIdentity } from "./resource.js";
import {
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { ExportEventRecord } from "@gh-symphony/core";

/** Internal owner only: callers supply a bounded processor, never an SDK queue.
 * A provider belongs to one process incarnation and is never registered globally.
 */
export function createOwnedLogProvider(
  identity: ProjectResourceIdentity,
  processor: LogRecordProcessor
) {
  const resource = createProjectResource(identity);
  const provider = new LoggerProvider({
    resource,
    processors: [processor],
    logRecordLimits: {
      attributeCountLimit: 64,
      // Core has already applied the distinct 1 KiB/16 KiB UTF-8 limits.
      attributeValueLengthLimit: Infinity,
    },
    loggerConfigurator: () => ({
      disabled: false,
      minimumSeverity: 0,
      traceBased: false,
    }),
  });
  const logger = provider.getLogger(
    "gh-symphony.orchestrator",
    identity.version
  );
  return {
    resource,
    provider,
    emit(record: ExportEventRecord): void {
      logger.emit({
        ...record,
        timestamp: epochTime(record.timestamp),
        observedTimestamp: epochTime(record.observedTimestamp),
        // Ambient instrumentation must not add trace context to this release.
        context: ROOT_CONTEXT,
      });
    },
  };
}

function epochTime(milliseconds: number): [number, number] {
  const seconds = Math.floor(milliseconds / 1000);
  return [seconds, Math.round((milliseconds - seconds * 1000) * 1_000_000)];
}

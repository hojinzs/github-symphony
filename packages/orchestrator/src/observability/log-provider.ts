import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { ExportEventRecord } from "@gh-symphony/core";

export type ProjectResourceIdentity = {
  version: string;
  projectId: string;
  projectSlug: string;
  trackerKind: string;
  attributes?: Record<string, string | number | boolean>;
};

/** Internal owner only: callers supply a bounded processor, never an SDK queue.
 * A provider belongs to one process incarnation and is never registered globally.
 */
export function createOwnedLogProvider(
  identity: ProjectResourceIdentity,
  processor: LogRecordProcessor
) {
  const reserved = {
    "service.name": "gh-symphony",
    "service.version": identity.version,
    "service.instance.id": randomUUID(),
    "symphony.project.id": identity.projectId,
    "symphony.project.slug": identity.projectSlug,
    "symphony.tracker.kind": identity.trackerKind,
  };
  const custom = identity.attributes ?? {};
  if (
    Object.keys(custom).filter((key) => !Object.hasOwn(reserved, key)).length >
    16
  ) {
    throw new Error("OTLP resource permits at most 16 custom attributes");
  }
  for (const [key, value] of Object.entries(custom)) {
    if (
      (Object.hasOwn(reserved, key) &&
        reserved[key as keyof typeof reserved] !== value) ||
      /(?:^|\.)(?:issue|run|session|turn)(?:\.|$)/i.test(key) ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      // Deliberately never echo caller-controlled names or values.
      throw new Error("OTLP custom resource attribute is invalid or reserved");
    }
  }
  const resource = resourceFromAttributes({ ...custom, ...reserved });
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

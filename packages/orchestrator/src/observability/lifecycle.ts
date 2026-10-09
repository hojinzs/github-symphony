import type {
  ObservabilityPublication,
  OtlpSafeDescriptor,
  ResolvedOtlpConfiguration,
} from "@gh-symphony/core";
import { freezeEvent, offerBestEffort } from "../publication.js";
import { assertOtlpProductionCapability } from "./activation.js";

export type SignalStatus = {
  state: "healthy" | "degraded";
  lastSuccessfulExportAt: string | null;
  dropped: Record<
    "queue_full" | "timeout" | "permanent" | "shutdown" | "mapping" | "partial",
    number
  >;
};

/** Owner-local extension: no SDK or new core status contract. */
export type TelemetryStatus = {
  enabled: boolean;
  state: "disabled" | "healthy" | "degraded";
  supportedSignals: readonly ["logs", "metrics"];
  applied: OtlpSafeDescriptor;
  pending: OtlpSafeDescriptor | null;
  restartRequired: boolean;
  signals: Partial<Record<"logs" | "metrics", SignalStatus>>;
};

export type TelemetryPipeline = ObservabilityPublication & {
  shutdown(deadline: number): Promise<void>;
  diagnostics?: () => Partial<Record<"logs" | "metrics", SignalStatus>>;
};

export type TelemetryStartup = {
  /** Internal capability only. CLI activation remains off until packaged audits. */
  productionCapability?: boolean;
  /** Tests can construct providers without enabling production startup. */
  createPipeline?: (
    applied: Readonly<ResolvedOtlpConfiguration>
  ) => Promise<TelemetryPipeline>;
  warning?: (message: string) => void;
};

// Stable equality is private memory only: header values must participate in
// restart detection, but neither the comparison nor its digest is published.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function settings(config: ResolvedOtlpConfiguration): string {
  return canonical({
    enabled: config.enabled,
    logs: config.logs,
    metrics: config.metrics,
    resourceAttributes: config.resourceAttributes,
    disabledReason: config.diagnostics.disabledReason,
  });
}

/** Freeze transport once. Reload validation belongs to the workflow owner;
 * only validated candidates reach this boundary. No hot replacement occurs.
 */
export async function createTelemetryLifecycle(
  configuration: ResolvedOtlpConfiguration,
  startup: TelemetryStartup = {}
) {
  const applied = freezeEvent(structuredClone(configuration));
  if (applied.enabled && !startup.createPipeline) {
    if (!startup.productionCapability) assertOtlpProductionCapability(true);
    // Complete production construction is supplied by the orchestrator owner,
    // never inferred from ambient OTEL variables.
    throw new Error("OTLP startup requires an owned pipeline constructor");
  }
  const pipeline = applied.enabled
    ? await startup.createPipeline!(applied)
    : undefined;
  const appliedSettings = settings(applied);
  let pending: OtlpSafeDescriptor | null = null;
  let pendingSettings: string | null = null;
  let degraded = false;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    publication: {
      offerEvent: (...args) => {
        if (!closing) offerBestEffort(() => pipeline?.offerEvent?.(...args));
      },
      offerSnapshot: (...args) => {
        if (!closing) offerBestEffort(() => pipeline?.offerSnapshot?.(...args));
      },
      observeTick: (...args) => {
        if (!closing) offerBestEffort(() => pipeline?.observeTick?.(...args));
      },
    } satisfies ObservabilityPublication,
    reload(candidate: ResolvedOtlpConfiguration): void {
      const next = settings(candidate);
      if (next === appliedSettings) {
        pending = null;
        pendingSettings = null;
        return;
      }
      if (next === pendingSettings) return;
      pendingSettings = next;
      pending = freezeEvent(structuredClone(candidate.diagnostics));
      offerBestEffort(() =>
        startup.warning?.(
          applied.enabled && !candidate.enabled
            ? "OTLP disable is pending restart; the applied destination remains active until restart"
            : "OTLP settings are pending restart; applied settings remain unchanged"
        )
      );
    },
    /** Accept bounded health state only, never an error or remote response. */
    health(state: "healthy" | "degraded"): void {
      degraded = state === "degraded";
    },
    status(): TelemetryStatus {
      const signals: TelemetryStatus["signals"] = {};
      try {
        const raw = pipeline?.diagnostics?.() ?? {};
        for (const signal of ["logs", "metrics"] as const) {
          const value = raw[signal];
          if (!value) continue;
          const dropped = {} as SignalStatus["dropped"];
          for (const reason of [
            "queue_full",
            "timeout",
            "permanent",
            "shutdown",
            "mapping",
            "partial",
          ] as const) {
            const count = value.dropped[reason];
            dropped[reason] =
              Number.isSafeInteger(count) && count >= 0 ? count : 0;
          }
          signals[signal] = {
            state: value.state === "degraded" ? "degraded" : "healthy",
            lastSuccessfulExportAt:
              typeof value.lastSuccessfulExportAt === "string" &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
                value.lastSuccessfulExportAt
              )
                ? value.lastSuccessfulExportAt
                : null,
            dropped,
          };
        }
      } catch {
        degraded = true;
      }
      return {
        enabled: applied.enabled,
        state: !applied.enabled
          ? "disabled"
          : degraded ||
              Object.values(signals).some(
                (signal) => signal.state === "degraded"
              )
            ? "degraded"
            : "healthy",
        supportedSignals: ["logs", "metrics"],
        applied: structuredClone(applied.diagnostics),
        pending: pending ? structuredClone(pending) : null,
        restartRequired: pending !== null,
        signals: structuredClone(signals),
      };
    },
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      if (!pipeline) return (shutdownPromise = Promise.resolve());
      const deadline = Date.now() + 5000;
      shutdownPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => pipeline.shutdown(deadline)),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
            }),
          ]);
        } catch {
          // Fixed local state only; exporter errors never enter lastError.
          degraded = true;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      return shutdownPromise;
    },
  };
}

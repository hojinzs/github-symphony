import {
  normalizeEventForExport,
  type EventAppendContext,
  type ExportableEvent,
  type OrchestratorEvent,
} from "@gh-symphony/core";
import { offerBestEffort } from "../publication.js";
import { ProtobufLogsSerializer } from "@opentelemetry/otlp-transformer";
import type {
  LogRecordProcessor,
  ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  createOwnedLogProvider,
  type ProjectResourceIdentity,
} from "./log-provider.js";
import {
  exportLogBatch,
  type BatchResult,
  type LogDestination,
  type LogRequest,
} from "./transport.js";

type Loss =
  | "queue_full"
  | "timeout"
  | "permanent"
  | "shutdown"
  | "mapping"
  | "partial";
type Category = "queue" | "transport" | "permanent";
export type LogDiagnostic = Readonly<{
  signal: "logs";
  category: Category | "shutdown";
  state: "failure" | "recovery";
  lost: number;
}>;
type Entry = { bytes: Uint8Array };
type Batch = { count: number; bytes: number; released: boolean };

/** Owns the only Logs queue. In-flight/retry bytes remain reserved until removed.
 * Network work begins in a microtask after the synchronous append offer returns.
 */
class BoundedLogProcessor implements LogRecordProcessor {
  private queue: Entry[] = [];
  private records = 0;
  private bytes = 0;
  private stopped = false;
  private reportedShutdownLosses = 0;
  private drainPromise: Promise<void> | undefined;
  private active: Batch | undefined;
  private controller = new AbortController();
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly losses: Record<Loss, number> = {
    queue_full: 0,
    timeout: 0,
    permanent: 0,
    shutdown: 0,
    mapping: 0,
    partial: 0,
  };
  private readonly episodes = new Map<
    Category,
    { at: number; pending: number }
  >();

  constructor(
    private readonly destination: LogDestination,
    private readonly request: LogRequest | undefined,
    private readonly diagnostic: (notice: LogDiagnostic) => void
  ) {
    this.interval = setInterval(() => {
      void this.drain();
    }, 1000);
    this.interval.unref();
  }

  onEmit(record: ReadWriteLogRecord): void {
    if (this.stopped) return;
    try {
      // Each protobuf request contributes repeated resource_logs fields. Their
      // concatenation is a valid ExportLogsServiceRequest with exact byte cost.
      const bytes = ProtobufLogsSerializer.serializeRequest([record]);
      if (!bytes) {
        this.loss("mapping", 1);
        return;
      }
      if (
        this.records >= 2048 ||
        this.bytes + bytes.byteLength > 8 * 1024 * 1024
      ) {
        this.loss("queue_full", 1);
        return;
      }
      this.queue.push({ bytes });
      this.records++;
      this.bytes += bytes.byteLength;
      if (this.queue.length >= 256 || this.bytes >= 1024 * 1024)
        void this.drain();
    } catch {
      this.loss("mapping", 1);
    }
  }

  status() {
    return {
      records: this.records,
      bytes: this.bytes,
      dropped: { ...this.losses },
    };
  }

  loss(reason: Loss, count: number): void {
    if (count <= 0) return;
    this.losses[reason] += count;
    const category =
      reason === "queue_full"
        ? "queue"
        : reason === "timeout"
          ? "transport"
          : "permanent";
    if (reason !== "shutdown" && reason !== "mapping")
      this.warn(category, count);
  }

  private notify(notice: LogDiagnostic): void {
    // Local-only, fixed safe fields. Never emit through an SDK/append observer.
    offerBestEffort(() => this.diagnostic(Object.freeze(notice)));
  }

  private warn(category: Category, lost: number): void {
    let episode = this.episodes.get(category);
    if (!episode) {
      episode = { at: Date.now(), pending: 0 };
      this.episodes.set(category, episode);
      this.notify({ signal: "logs", category, state: "failure", lost });
      return;
    }
    episode.pending += lost;
    if (Date.now() - episode.at >= 60_000) {
      const summary = episode.pending;
      episode.pending = 0;
      episode.at = Date.now();
      this.notify({
        signal: "logs",
        category,
        state: "failure",
        lost: summary,
      });
    }
  }

  private recovery(): void {
    for (const category of this.episodes.keys()) {
      if (
        category === "queue" &&
        (this.records >= 1024 || this.bytes >= 4 * 1024 * 1024)
      )
        continue;
      this.episodes.delete(category);
      this.notify({ signal: "logs", category, state: "recovery", lost: 0 });
    }
  }

  private release(batch: Batch, result: BatchResult): void {
    if (batch.released) return;
    batch.released = true;
    this.records -= batch.count;
    this.bytes -= batch.bytes;
    if (result.reason) this.loss(result.reason, result.rejected);
    if (!result.reason || result.reason === "partial") this.recovery();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = Promise.resolve()
      .then(async () => {
        const controller = this.controller;
        while (this.queue.length && !controller.signal.aborted) {
          const entries: Entry[] = [];
          let bytes = 0;
          while (entries.length < 256 && this.queue.length) {
            const next = this.queue[0]!;
            if (bytes + next.bytes.byteLength > 1024 * 1024) break;
            entries.push(this.queue.shift()!);
            bytes += next.bytes.byteLength;
          }
          // Core limits bound singleton encodings below the batch limit.
          if (!entries.length) {
            const invalid = this.queue.shift()!;
            this.records--;
            this.bytes -= invalid.bytes.byteLength;
            this.loss("mapping", 1);
            continue;
          }
          const count = entries.length;
          const batch: Batch = { count, bytes, released: false };
          this.active = batch;
          const body = Buffer.concat(
            entries.map((entry) =>
              Buffer.from(
                entry.bytes.buffer,
                entry.bytes.byteOffset,
                entry.bytes.byteLength
              )
            ),
            bytes
          );
          entries.length = 0; // retain only the batch body during network/retry waits
          let result: BatchResult;
          try {
            result = await exportLogBatch(
              this.destination,
              body,
              count,
              controller.signal,
              this.request,
              undefined,
              () => this.warn("transport", 0)
            );
          } catch {
            result = { reason: "permanent", rejected: count };
          }
          this.release(batch, result);
          this.active = undefined;
        }
      })
      .finally(() => {
        this.drainPromise = undefined;
      });
    return this.drainPromise;
  }

  async flush(deadline: number): Promise<void> {
    deadline = Number.isNaN(deadline)
      ? Date.now()
      : Math.min(deadline, Date.now() + 5000);
    if (this.controller.signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      const expire = () => {
        this.controller.abort();
        // A flush deadline discards pending work, but only close stops admission.
        this.controller = new AbortController();
        if (this.active)
          this.release(this.active, {
            reason: "shutdown",
            rejected: this.active.count,
          });
        this.loss("shutdown", this.queue.length);
        this.queue = [];
        this.records = 0;
        this.bytes = 0;
        resolve();
      };
      if (deadline <= Date.now()) expire();
      else timer = setTimeout(expire, deadline - Date.now());
    });
    try {
      await Promise.race([
        (async () => {
          do {
            await this.drain();
          } while (this.queue.length);
        })(),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  forceFlush(): Promise<void> {
    return this.flush(Date.now() + 5000);
  }

  async close(deadline: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.interval);
    const previous = this.reportedShutdownLosses;
    await this.flush(deadline);
    this.reportedShutdownLosses = this.losses.shutdown;
    if (this.losses.shutdown > previous)
      this.notify({
        signal: "logs",
        category: "shutdown",
        state: "failure",
        lost: this.losses.shutdown - previous,
      });
  }

  shutdown(): Promise<void> {
    return this.close(Date.now() + 5000);
  }
}

/** Internal/test injection only; not exported from the package entry point. */
export function createLogPipeline(
  identity: ProjectResourceIdentity,
  destination: LogDestination,
  options: {
    request?: LogRequest;
    diagnostic?: (notice: LogDiagnostic) => void;
  } = {}
) {
  // Resource validation happens before creating any processor timers.
  const proxy: LogRecordProcessor = {
    onEmit: (record) => processor!.onEmit(record),
    forceFlush: () => processor!.forceFlush(),
    shutdown: () => processor!.shutdown(),
  };
  const owner = createOwnedLogProvider(identity, proxy);
  const processor = new BoundedLogProcessor(
    { endpoint: destination.endpoint, headers: { ...destination.headers } },
    options.request,
    options.diagnostic ??
      ((notice) => {
        process.stderr.write(
          `${JSON.stringify({ event: "otlp-diagnostic", ...notice })}\n`
        );
      })
  );
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;
  return {
    offerEvent(
      event: Readonly<ExportableEvent | OrchestratorEvent>,
      context: Readonly<EventAppendContext>
    ): void {
      if (closed) return;
      try {
        const result = normalizeEventForExport(event, context);
        if (!result.ok) {
          processor!.loss("mapping", 1);
          return;
        }
        owner.emit(result.record);
      } catch {
        processor!.loss("mapping", 1);
      }
    },
    status: () => processor!.status(),
    flush: (deadline: number) => processor!.flush(deadline),
    shutdown(deadline: number): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      shutdownPromise = (async () => {
        await processor.close(deadline);
        await owner.provider.shutdown();
      })();
      return shutdownPromise;
    },
  };
}

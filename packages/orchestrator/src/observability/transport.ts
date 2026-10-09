import http from "node:http";
import https from "node:https";
import {
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
} from "@opentelemetry/otlp-transformer";

export type LogDestination = {
  endpoint: string;
  headers: Record<string, string>;
};
export type HttpResult = {
  status: number;
  retryAfter: string | null;
  body: Uint8Array;
};
export type LogRequest = (
  destination: LogDestination,
  body: Uint8Array,
  signal: AbortSignal
) => Promise<HttpResult>;
export type BatchResult = {
  rejected: number;
  reason?: "timeout" | "permanent" | "partial" | "shutdown";
};

class PermanentLogRequestError extends Error {}

/** Single adapter retry owner: no SDK exporter retry loop underneath it. */
export async function exportLogBatch(
  destination: LogDestination,
  body: Uint8Array,
  count: number,
  signal: AbortSignal,
  request: LogRequest = requestProtobuf,
  random: () => number = Math.random,
  onTransientFailure?: () => void
): Promise<BatchResult> {
  return exportBatch(
    destination,
    body,
    count,
    signal,
    "logs",
    request,
    random,
    onTransientFailure
  );
}

/** Metric retries retain the original serialized points and timestamps. */
export async function exportMetricBatch(
  destination: LogDestination,
  body: Uint8Array,
  count: number,
  signal: AbortSignal,
  request: LogRequest = requestProtobuf,
  random: () => number = Math.random,
  onTransientFailure?: () => void
): Promise<BatchResult> {
  return exportBatch(
    destination,
    body,
    count,
    signal,
    "metrics",
    request,
    random,
    onTransientFailure
  );
}

async function exportBatch(
  destination: LogDestination,
  body: Uint8Array,
  count: number,
  signal: AbortSignal,
  kind: "logs" | "metrics",
  request: LogRequest,
  random: () => number,
  onTransientFailure?: () => void
): Promise<BatchResult> {
  const expires = Date.now() + 10_000;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) return { reason: "shutdown", rejected: count };
    const remaining = expires - Date.now();
    if (remaining <= 0) return { reason: "timeout", rejected: count };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, remaining));
    let response: HttpResult | undefined;
    try {
      response = await request(destination, body, controller.signal);
    } catch (error) {
      if (error instanceof PermanentLogRequestError)
        return { reason: "permanent", rejected: count };
      // Transport errors are classified locally; never expose messages/URLs.
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    if (signal.aborted) return { reason: "shutdown", rejected: count };
    if (controller.signal.aborted) response = undefined;
    if (response?.status === 200) {
      try {
        const rejected =
          kind === "logs"
            ? (ProtobufLogsSerializer.deserializeResponse(response.body)
                ?.partialSuccess?.rejectedLogRecords ?? 0)
            : (ProtobufMetricsSerializer.deserializeResponse(response.body)
                ?.partialSuccess?.rejectedDataPoints ?? 0);
        if (
          !Number.isSafeInteger(rejected) ||
          rejected < 0 ||
          rejected > count
        ) {
          return { reason: "permanent", rejected: count };
        }
        return rejected > 0 ? { reason: "partial", rejected } : { rejected: 0 };
      } catch {
        return { reason: "permanent", rejected: count };
      }
    }
    if (response && ![429, 502, 503, 504].includes(response.status)) {
      return { reason: "permanent", rejected: count };
    }
    try {
      onTransientFailure?.();
    } catch {
      /* diagnostics never alter retry behavior */
    }
    if (attempt === 2) {
      return { reason: "timeout", rejected: count };
    }
    const backoff = 500 * 2 ** attempt * (1 + random() * 0.2);
    const wait = Math.max(backoff, retryAfterMillis(response?.retryAfter));
    if (wait >= expires - Date.now()) {
      return { reason: "timeout", rejected: count };
    }
    await abortableDelay(wait, signal);
  }
  return { reason: "timeout", rejected: count };
}

function retryAfterMillis(value: string | null | undefined): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : 0;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Cancellable one-shot HTTP/protobuf, explicit options, no ambient OTEL env.
 * Response bytes are bounded and are never included in diagnostics.
 */
export const requestProtobuf: LogRequest = (destination, body, signal) =>
  new Promise((resolve, reject) => {
    const url = new URL(destination.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      reject(new PermanentLogRequestError("Invalid OTLP destination"));
      return;
    }
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "POST",
        agent: false,
        signal,
        headers: {
          ...destination.headers,
          "content-type": "application/x-protobuf",
          "content-length": body.byteLength,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) {
            response.destroy(
              new PermanentLogRequestError("OTLP response exceeds limit")
            );
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            retryAfter:
              typeof response.headers["retry-after"] === "string"
                ? response.headers["retry-after"]
                : null,
            body: Buffer.concat(chunks, bytes),
          })
        );
      }
    );
    request.on("error", reject);
    request.end(body);
  });

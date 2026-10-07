import { afterEach, describe, expect, it, vi } from "vitest";
import { exportLogBatch } from "./transport.js";

afterEach(() => vi.useRealTimers());
describe("bounded OTLP transport", () => {
  it("does not accept a success that arrives after the attempt was aborted", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const result = exportLogBatch(
      { endpoint: "http://receiver/v1/logs", headers: {} },
      new Uint8Array(),
      1,
      new AbortController().signal,
      async (_target, _body, signal) => {
        calls++;
        return new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                status: 200,
                retryAfter: null,
                body: new Uint8Array(),
              }),
            { once: true }
          )
        );
      },
      () => 0
    );
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ reason: "timeout", rejected: 1 });
    expect(calls).toBe(3);
  });
  it("retries transient statuses only twice with identical bytes", async () => {
    vi.useFakeTimers();
    const bodies: Uint8Array[] = [];
    const result = exportLogBatch(
      { endpoint: "http://receiver/v1/logs", headers: {} },
      new Uint8Array([1, 2]),
      4,
      new AbortController().signal,
      async (_target, body) => {
        bodies.push(body);
        return { status: 503, retryAfter: null, body: new Uint8Array() };
      },
      () => 0
    );
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ reason: "timeout", rejected: 4 });
    expect(bodies).toHaveLength(3);
    expect(bodies.every((body) => body === bodies[0])).toBe(true);
  });
  it.each([400, 401, 403, 404, 500])(
    "does not retry permanent HTTP %i",
    async (status) => {
      let calls = 0;
      const result = await exportLogBatch(
        { endpoint: "http://receiver/v1/logs", headers: {} },
        new Uint8Array(),
        3,
        new AbortController().signal,
        async () => {
          calls++;
          return { status, retryAfter: null, body: new Uint8Array() };
        }
      );
      expect(calls).toBe(1);
      expect(result).toEqual({ reason: "permanent", rejected: 3 });
    }
  );
  it("counts partial rejection without retry or receiver diagnostic echoes", async () => {
    let calls = 0;
    // ExportLogsServiceResponse partial_success { rejected_log_records: 2 }
    const result = await exportLogBatch(
      { endpoint: "http://receiver/v1/logs", headers: {} },
      new Uint8Array(),
      3,
      new AbortController().signal,
      async () => {
        calls++;
        return {
          status: 200,
          retryAfter: null,
          body: new Uint8Array([10, 2, 8, 2]),
        };
      }
    );
    expect(result).toEqual({ reason: "partial", rejected: 2 });
    expect(calls).toBe(1);
  });
  it("discards Retry-After that exceeds total lifetime", async () => {
    let calls = 0;
    expect(
      await exportLogBatch(
        { endpoint: "http://receiver/v1/logs", headers: {} },
        new Uint8Array(),
        1,
        new AbortController().signal,
        async () => {
          calls++;
          return { status: 429, retryAfter: "60", body: new Uint8Array() };
        }
      )
    ).toEqual({ reason: "timeout", rejected: 1 });
    expect(calls).toBe(1);
  });
  it("aborts stalled attempts and exhausts a finite attempt budget", async () => {
    vi.useFakeTimers();
    let aborted = 0;
    const result = exportLogBatch(
      { endpoint: "http://receiver/v1/logs", headers: {} },
      new Uint8Array(),
      1,
      new AbortController().signal,
      async (_target, _body, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted++;
              reject(new Error("secret echo"));
            },
            { once: true }
          )
        ),
      () => 0
    );
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ reason: "timeout", rejected: 1 });
    expect(aborted).toBe(3);
  });
});

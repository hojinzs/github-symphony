import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogPipeline } from "./log-pipeline.js";

const identity = {
  version: "test",
  projectId: "p",
  projectSlug: "o/r",
  trackerKind: "file",
};
const event = {
  at: "2026-10-07T00:00:00Z",
  event: "run-failed" as const,
  runId: "r",
  error: "redacted",
};
const context = { observedAt: "2026-10-07T00:00:01Z", runId: "r" };
afterEach(() => vi.useRealTimers());
describe("bounded Logs pipeline", () => {
  it("warns on the first failed attempt before retry and reports recovery without loss", async () => {
    vi.useFakeTimers();
    const notices: unknown[] = [];
    let attempts = 0;
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async () => ({
          status: ++attempts === 1 ? 503 : 200,
          retryAfter: null,
          body: new Uint8Array(),
        }),
        diagnostic: (notice) => notices.push(notice),
      }
    );
    pipeline.offerEvent(event, context);
    const flush = pipeline.flush(Date.now() + 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(notices).toEqual([
      { signal: "logs", category: "transport", state: "failure", lost: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    await flush;
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({
      category: "transport",
      state: "recovery",
    });
    expect(pipeline.status().dropped.timeout).toBe(0);
    await pipeline.shutdown(Date.now() + 5000);
  });
  it("summarizes suppressed episode losses after sixty seconds", async () => {
    vi.useFakeTimers();
    const notices: { state: string; lost: number }[] = [];
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async () => ({
          status: 401,
          retryAfter: null,
          body: new Uint8Array(),
        }),
        diagnostic: (notice) => notices.push(notice),
      }
    );
    for (let i = 0; i < 2; i++) {
      pipeline.offerEvent(event, context);
      await pipeline.flush(Date.now() + 5000);
    }
    expect(notices).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000);
    pipeline.offerEvent(event, context);
    await pipeline.flush(Date.now() + 5000);
    expect(notices).toHaveLength(2);
    expect(notices[1]!.lost).toBe(2);
    await pipeline.shutdown(Date.now() + 5000);
  });
  it("shares shutdown completion across callers without a second drain deadline", async () => {
    vi.useFakeTimers();
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async (_target, _body, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("abort")), {
              once: true,
            })
          ),
        diagnostic: () => {},
      }
    );
    pipeline.offerEvent(event, context);
    let firstDone = false,
      secondDone = false;
    const first = pipeline.shutdown(Date.now() + 5000).then(() => {
      firstDone = true;
    });
    const second = pipeline.shutdown(Date.now() + 5000).then(() => {
      secondDone = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect([firstDone, secondDone]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([first, second]);
    expect(pipeline.status()).toMatchObject({
      records: 0,
      bytes: 0,
      dropped: { shutdown: 1 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds large encoded batches and drains every admitted record once", async () => {
    vi.useFakeTimers();
    const bodies: Uint8Array[] = [];
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async (_target, body) => {
          bodies.push(body);
          return { status: 200, retryAfter: null, body: new Uint8Array() };
        },
        diagnostic: () => {},
      }
    );
    for (let i = 0; i < 400; i++)
      pipeline.offerEvent({ ...event, error: "x".repeat(16384) }, context);
    await pipeline.flush(Date.now() + 5000);
    expect(bodies.length).toBeGreaterThan(2);
    expect(bodies.every((body) => body.byteLength <= 1024 * 1024)).toBe(true);
    expect(pipeline.status()).toMatchObject({
      records: 0,
      bytes: 0,
      dropped: { queue_full: 0 },
    });
    await pipeline.shutdown(Date.now() + 5000);
  });
  it("resets queue-loss episodes only below half occupancy after a successful drain", async () => {
    vi.useFakeTimers();
    const notices: { category: string; state: string }[] = [];
    const recoveredOccupancy: number[] = [];
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async () => ({
          status: 200,
          retryAfter: null,
          body: new Uint8Array(),
        }),
        diagnostic: (notice) => {
          notices.push(notice);
          if (notice.category === "queue" && notice.state === "recovery")
            recoveredOccupancy.push(pipeline.status().records);
        },
      }
    );
    for (let i = 0; i < 2050; i++) pipeline.offerEvent(event, context);
    expect(notices).toEqual([
      { signal: "logs", category: "queue", state: "failure", lost: 1 },
    ]);
    await pipeline.flush(Date.now() + 5000);
    expect(
      notices.filter((notice) => notice.state === "recovery")
    ).toHaveLength(1);
    expect(recoveredOccupancy.every((records) => records < 1024)).toBe(true);
    for (let i = 0; i < 2049; i++) pipeline.offerEvent(event, context);
    expect(notices.filter((notice) => notice.state === "failure")).toHaveLength(
      2
    );
    await pipeline.shutdown(Date.now() + 5000);
  });
  it("never re-exports diagnostics and contains a rejecting diagnostic sink", async () => {
    const bodies: Uint8Array[] = [];
    const notices: unknown[] = [];
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async (_target, body) => {
          bodies.push(body);
          throw new Error("receiver echoed Bearer secret");
        },
        diagnostic: async (notice) => {
          notices.push(notice);
          throw new Error("sink secret");
        },
      }
    );
    pipeline.offerEvent(event, context);
    await pipeline.shutdown(Date.now() + 20);
    expect(bodies).toHaveLength(1);
    expect(notices).toHaveLength(2);
    expect(JSON.stringify(notices)).not.toContain("secret");
    expect(pipeline.status()).toMatchObject({
      records: 0,
      dropped: { shutdown: 1 },
    });
  });

  it("counts in-flight records toward saturation, drops newest once and serializes concurrent drains", async () => {
    vi.useFakeTimers();
    let complete: (() => void) | undefined;
    let concurrent = 0,
      peak = 0,
      requests = 0;
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async () => {
          requests++;
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise<void>((resolve) => {
            complete = resolve;
          });
          concurrent--;
          return { status: 200, retryAfter: null, body: new Uint8Array() };
        },
        diagnostic: () => {},
      }
    );
    for (let i = 0; i < 2048; i++) pipeline.offerEvent(event, context);
    await vi.advanceTimersByTimeAsync(0);
    pipeline.offerEvent(event, context);
    expect(pipeline.status()).toMatchObject({
      records: 2048,
      dropped: { queue_full: 1 },
    });
    expect(requests).toBe(1);
    const firstFlush = pipeline.flush(Date.now() + 5000);
    const secondFlush = pipeline.flush(Date.now() + 5000);
    for (let i = 0; i < 8; i++) {
      complete!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all([firstFlush, secondFlush]);
    expect(peak).toBe(1);
    expect(requests).toBe(8);
    expect(pipeline.status().records).toBe(0);
    await pipeline.shutdown(Date.now() + 5000);
  });
  it("enforces encoded byte capacity before the count capacity", async () => {
    vi.useFakeTimers();
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      { diagnostic: () => {} }
    );
    const large = { ...event, error: "x".repeat(16384) };
    for (let i = 0; i < 800; i++) pipeline.offerEvent(large, context);
    const status = pipeline.status();
    expect(status.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(status.records).toBeLessThan(800);
    expect(status.dropped.queue_full).toBe(800 - status.records);
    await pipeline.shutdown(Date.now());
  });
  it("counts mapping losses independently of successful local publication", async () => {
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      { diagnostic: () => {} }
    );
    expect(() =>
      pipeline.offerEvent({ ...event, at: "invalid" }, context)
    ).not.toThrow();
    expect(pipeline.status()).toMatchObject({
      records: 0,
      dropped: { mapping: 1 },
    });
    await pipeline.shutdown(Date.now());
  });
  it("expires shutdown once, stops offers and leaves no timers or queue", async () => {
    vi.useFakeTimers();
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async (_target, _bytes, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("secret")),
              { once: true }
            )
          ),
        diagnostic: () => {},
      }
    );
    for (let i = 0; i < 300; i++) pipeline.offerEvent(event, context);
    await vi.advanceTimersByTimeAsync(0);
    const shutdown = pipeline.shutdown(Date.now() + 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;
    pipeline.offerEvent(event, context);
    expect(pipeline.status()).toMatchObject({
      records: 0,
      bytes: 0,
      dropped: { shutdown: 300 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("throttles warning episodes and resets only on successful drain", async () => {
    vi.useFakeTimers();
    const notices: unknown[] = [];
    let healthy = false;
    const pipeline = createLogPipeline(
      identity,
      { endpoint: "http://receiver/v1/logs", headers: {} },
      {
        request: async () => ({
          status: healthy ? 200 : 401,
          retryAfter: null,
          body: new Uint8Array(),
        }),
        diagnostic: (notice) => notices.push(notice),
      }
    );
    pipeline.offerEvent(event, context);
    await pipeline.flush(Date.now() + 5000);
    pipeline.offerEvent(event, context);
    await pipeline.flush(Date.now() + 5000);
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain("receiver");
    healthy = true;
    pipeline.offerEvent(event, context);
    await pipeline.flush(Date.now() + 5000);
    expect(notices).toHaveLength(2);
    healthy = false;
    pipeline.offerEvent(event, context);
    await pipeline.flush(Date.now() + 5000);
    expect(notices).toHaveLength(3);
    expect(pipeline.status().dropped.permanent).toBe(3);
    await pipeline.shutdown(Date.now() + 5000);
  });
});

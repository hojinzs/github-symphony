import { afterEach, expect, it, vi } from "vitest";
import { createMetricPipeline } from "./metric-pipeline.js";
const identity = {
  version: "test",
  projectId: "folder",
  projectSlug: "owner/repo",
  trackerKind: "file",
};
const destination = { endpoint: "http://receiver/v1/metrics", headers: {} };
const ok = { status: 200, retryAfter: null, body: new Uint8Array() };
const projection = {
  sourceTime: "2026-10-09T00:00:00Z",
  activeRuns: 1,
  retryingRuns: 0,
  health: { idle: 0, running: 1, degraded: 0 } as const,
  tickOutcomes: { dispatched: 1, suppressed: 0, recovered: 0, skipped: 0 },
  tokensSupported: { codex: 1, claude: 0 } as const,
  tokenTotals: null,
  runtimeSeconds: 10,
};
const snapshot = (sequence: number) => ({
  projectId: "folder",
  instanceId: "process",
  sequence,
  projection,
});
afterEach(() => {
  vi.useRealTimers();
});

it("OT-05 bounds collection concurrency to one batch and one coalesced pending request", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const p = createMetricPipeline(identity, destination, {
    diagnostic: () => {},
    request: async () => {
      count++;
      if (count === 1) await held;
      return ok;
    },
  });
  try {
    p.offerSnapshot(snapshot(1));
    const first = p.collect();
    await vi.waitFor(() => expect(count).toBe(1));
    const promises: Promise<void>[] = [];
    for (let i = 2; i <= 10000; i++) {
      p.offerSnapshot(snapshot(i));
      promises.push(p.collect());
    }
    expect(new Set(promises)).toEqual(new Set([first]));
    expect(p.status()).toMatchObject({
      sequence: 10000,
      inFlight: true,
      pending: true,
    });
    expect(count).toBe(1);
    release();
    await first;
    expect(count).toBe(2);
    expect(p.status()).toMatchObject({ inFlight: false, pending: false });
  } finally {
    release();
    await p.shutdown(Date.now() + 5000);
  }
});

it("collects every ten seconds without collecting on offers or loss diagnostics", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => ok);
  const diagnostic = vi.fn();
  const p = createMetricPipeline(identity, destination, {
    request,
    diagnostic,
  });
  try {
    p.offerSnapshot(snapshot(1));
    await vi.advanceTimersByTimeAsync(9999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({
      ...ok,
      body: new Uint8Array([10, 2, 8, 2]),
    });
    await p.collect();
    expect(request).toHaveBeenCalledTimes(2);
    expect(diagnostic).toHaveBeenCalledWith({
      signal: "metrics",
      state: "failure",
      reason: "partial",
      lost: 2,
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    await p.shutdown(Date.now() + 5000);
  }
});

it("aborts a held flush by the shared deadline and shares shutdown completion", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const p = createMetricPipeline(identity, destination, {
    diagnostic: () => {},
    request: async (_destination, _body, signal) => {
      attempts++;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        })
      );
    },
  });
  p.offerSnapshot(snapshot(1));
  const a = p.shutdown(Date.now() + 100);
  expect(p.shutdown(Date.now() + 5000)).toBe(a);
  p.offerSnapshot(snapshot(2));
  await vi.advanceTimersByTimeAsync(100);
  await a;
  expect(attempts).toBe(1);
  expect(p.status()).toMatchObject({ inFlight: false, pending: false });
  p.offerSnapshot(snapshot(2));
  await p.collect();
  await vi.advanceTimersByTimeAsync(30000);
  expect(attempts).toBe(1);
  expect(p.status().sequence).toBe(1);
});

import { afterEach, expect, it, vi } from "vitest";
import { parseOtlpPolicy, resolveOtlpConfiguration } from "@gh-symphony/core";
import { createProjectPipeline } from "./pipeline.js";

const identity = {
  version: "test",
  projectId: "p",
  projectSlug: "o/r",
  trackerKind: "file",
};
const config = () =>
  resolveOtlpConfiguration(
    parseOtlpPolicy({
      otlp: { enabled: true, endpoint: "https://collector.example" },
    }),
    {}
  );
const event = {
  at: "2026-10-07T00:00:00Z",
  event: "run-failed" as const,
  runId: "r",
  error: "redacted",
};
afterEach(() => vi.useRealTimers());

it("OT-12: complete pipeline exposes bounded loss/health and successful export timestamps", async () => {
  vi.useFakeTimers();
  let failing = true;
  const request = vi.fn(async () => ({
    status: failing ? 400 : 200,
    retryAfter: null,
    body: failing
      ? new TextEncoder().encode("Bearer forbidden-response")
      : new Uint8Array(),
  }));
  const diagnostic = vi.fn();
  const p = createProjectPipeline(identity, config(), {
    logs: { request, diagnostic },
    metrics: { request, diagnostic },
  });
  p.offerEvent!(event, { observedAt: event.at, runId: "r" });
  p.observeTick!({ durationSeconds: 1, outcome: "success" });
  await vi.advanceTimersByTimeAsync(10000);
  const failed = p.diagnostics!();
  expect(failed.logs).toMatchObject({
    state: "degraded",
    dropped: { permanent: 1 },
    lastSuccessfulExportAt: null,
  });
  expect(failed.metrics!.state).toBe("degraded");
  expect(failed.metrics!.dropped.permanent).toBeGreaterThan(0);
  expect(JSON.stringify([failed, diagnostic.mock.calls])).not.toContain(
    "forbidden-response"
  );
  failing = false;
  p.offerEvent!(event, { observedAt: event.at, runId: "r" });
  await vi.advanceTimersByTimeAsync(10000);
  expect(p.diagnostics!().logs).toMatchObject({
    state: "healthy",
    lastSuccessfulExportAt: expect.any(String),
  });
  expect(p.diagnostics!().metrics).toMatchObject({
    state: "healthy",
    lastSuccessfulExportAt: expect.any(String),
  });
  await p.shutdown(Date.now() + 5000);
  expect(vi.getTimerCount()).toBe(0);
});

it("OT-11: both real providers flush concurrently, abort and discard within one five-second budget", async () => {
  vi.useFakeTimers();
  const aborts: string[] = [];
  const request = vi.fn(
    async (
      target: { endpoint: string },
      _bytes: Uint8Array,
      signal: AbortSignal
    ) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborts.push(target.endpoint);
            reject(new Error("secret echo"));
          },
          { once: true }
        )
      )
  );
  const p = createProjectPipeline(identity, config(), {
    logs: { request, diagnostic: () => {} },
    metrics: { request, diagnostic: () => {} },
  });
  p.offerEvent!(event, { observedAt: event.at, runId: "r" });
  p.observeTick!({ durationSeconds: 1, outcome: "success" });
  const started = Date.now();
  const closing = p.shutdown(started + 5000);
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  await closing;
  expect(Date.now() - started).toBe(5000);
  expect([...new Set(aborts)].sort()).toEqual([
    "https://collector.example/v1/logs",
    "https://collector.example/v1/metrics",
  ]);
  expect(p.diagnostics!().logs!.dropped.shutdown).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

import { expect, it } from "vitest";
import { initializeLogs } from "./activation.js";

it("activates a real Logs pipeline only through explicit internal injection", async () => {
  const requests: { endpoint: string; bytes: number }[] = [];
  const pipeline = await initializeLogs(true, {
    identity: {
      version: "test",
      projectId: "injected-project",
      projectSlug: "owner/repo",
      trackerKind: "file",
    },
    destination: { endpoint: "http://injected/v1/logs", headers: {} },
    options: {
      request: async (destination, body) => {
        requests.push({
          endpoint: destination.endpoint,
          bytes: body.byteLength,
        });
        return { status: 200, retryAfter: null, body: new Uint8Array() };
      },
      diagnostic: () => {},
    },
  });
  expect(pipeline).toBeDefined();
  try {
    pipeline!.offerEvent(
      { at: "2026-10-09T00:00:00Z", event: "run-dispatched", runId: "run-1" },
      { observedAt: "2026-10-09T00:00:01Z", runId: "run-1" }
    );
    expect(pipeline!.status().records).toBe(1);
    await pipeline!.flush(Date.now() + 5000);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.endpoint).toBe("http://injected/v1/logs");
    expect(requests[0]!.bytes).toBeGreaterThan(0);
    expect(pipeline!.status()).toMatchObject({
      records: 0,
      bytes: 0,
      dropped: { permanent: 0 },
    });
  } finally {
    await pipeline!.shutdown(Date.now() + 5000);
  }
});

import http from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { initializeMetrics } from "./activation.js";

// Independent protobuf wire decoder for the schema field IDs in official proto
// v1.9.0: collector/metrics/v1/metrics_service.proto, metrics/v1/metrics.proto, common/v1/common.proto.
// It does not call the production serializer to compute expectations.
type Field = { id: number; value: Buffer | bigint };
function fields(bytes: Buffer): Field[] {
  let pos = 0;
  const readVarint = () => {
    let value = 0n,
      shift = 0n;
    for (;;) {
      const b = bytes[pos++]!;
      value |= BigInt(b & 127) << shift;
      if (!(b & 128)) return value;
      shift += 7n;
      if (pos > bytes.length || shift > 70n) throw new Error("invalid varint");
    }
  };
  const result: Field[] = [];
  while (pos < bytes.length) {
    const tag = Number(readVarint());
    let value: Buffer | bigint;
    switch (tag & 7) {
      case 0:
        value = readVarint();
        break;
      case 1:
        value = bytes.readBigUInt64LE(pos);
        pos += 8;
        break;
      case 2: {
        const size = Number(readVarint());
        value = bytes.subarray(pos, pos + size);
        pos += size;
        break;
      }
      case 5:
        value = BigInt(bytes.readUInt32LE(pos));
        pos += 4;
        break;
      default:
        throw new Error("unexpected wire type");
    }
    result.push({ id: tag >>> 3, value });
  }
  return result;
}
const nested = (f: Field[], id: number) =>
  f
    .filter((field) => field.id === id)
    .map((field) => fields(field.value as Buffer));
const text = (f: Field[], id: number) =>
  (f.find((field) => field.id === id)!.value as Buffer).toString();
const scalar = (f: Field[], id: number) =>
  f.find((field) => field.id === id)?.value;
const attributes = (f: Field[], id: number) =>
  Object.fromEntries(
    nested(f, id).map((kv) => {
      const value = nested(kv, 2)[0]![0]!;
      return [
        text(kv, 1),
        Buffer.isBuffer(value.value) ? value.value.toString() : value.value,
      ];
    })
  );

it("OT-01/06 sends real Metrics protobuf with cumulative points and byte-identical retries", async () => {
  const received: {
    bytes: Buffer;
    headers: http.IncomingHttpHeaders;
    path?: string;
  }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({
      bytes: Buffer.concat(chunks),
      headers: req.headers,
      path: req.url,
    });
    res.writeHead(received.length === 1 ? 503 : 200);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const p = (await initializeMetrics(true, {
    identity: {
      version: "1.2.3",
      projectId: "folder",
      projectSlug: "owner/repo",
      trackerKind: "file",
    },
    destination: {
      endpoint: `http://127.0.0.1:${port}/v1/metrics`,
      headers: { authorization: "Bearer test-only" },
    },
    options: { diagnostic: () => {} },
  }))!;
  try {
    p.offerSnapshot({
      projectId: "folder",
      instanceId: "facade",
      sequence: 1,
      projection: {
        sourceTime: "2026-10-09T00:00:00Z",
        activeRuns: 1,
        retryingRuns: 0,
        health: { idle: 0, running: 1, degraded: 0 },
        pollIntervalMs: 30000,
        tickOutcomes: {
          dispatched: 2,
          suppressed: 0,
          recovered: 1,
          skipped: 0,
        },
        tokensSupported: { codex: 1, claude: 0 },
        tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        runtimeSeconds: 42,
      },
    });
    p.observeTick({ durationSeconds: 0.02, outcome: "success" });
    p.recordLoss("logs", "queue_full", 2);
    await p.collect();
    expect(received).toHaveLength(2);
    expect(received[0]!.bytes).toEqual(received[1]!.bytes);
    const request = received[1]!;
    expect(request.path).toBe("/v1/metrics");
    expect(request.headers.authorization).toBe("Bearer test-only");
    expect(request.headers["content-type"]).toBe("application/x-protobuf");
    const rm = nested(fields(request.bytes), 1)[0]!;
    expect(attributes(nested(rm, 1)[0]!, 1)).toMatchObject({
      "service.name": "gh-symphony",
      "service.version": "1.2.3",
      "symphony.project.id": "folder",
      "symphony.project.slug": "owner/repo",
      "symphony.tracker.kind": "file",
    });
    const resource = attributes(nested(rm, 1)[0]!, 1);
    expect(String(resource["service.instance.id"])).toMatch(/^[0-9a-f-]{36}$/);
    const scope = nested(rm, 2)[0]!;
    expect(text(nested(scope, 1)[0]!, 1)).toBe("gh-symphony.orchestrator");
    const catalog = Object.fromEntries(
      nested(scope, 2).map((m) => [text(m, 1), m])
    );
    expect(Object.keys(catalog).sort()).toEqual(
      [
        "symphony.runs.active",
        "symphony.runs.retrying",
        "symphony.health",
        "symphony.poll.interval",
        "symphony.tick.outcomes",
        "symphony.tokens.total",
        "symphony.tokens.supported",
        "symphony.runtime.total",
        "symphony.tick.duration",
        "symphony.telemetry.dropped",
      ].sort()
    );
    expect(text(catalog["symphony.tokens.total"]!, 3)).toBe("{token}");
    expect(text(catalog["symphony.runtime.total"]!, 3)).toBe("s");
    const sum = nested(catalog["symphony.tick.outcomes"]!, 7)[0]!;
    expect(scalar(sum, 2)).toBe(2n); // CUMULATIVE
    expect(scalar(sum, 3)).toBe(1n); // monotonic
    const decisions = nested(sum, 1);
    expect(attributes(decisions[0]!, 7)).toEqual({ outcome: "dispatched" });
    const number = (point: Field[]) => {
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64LE(scalar(point, 4) as bigint);
      return bytes.readDoubleLE();
    };
    expect(decisions.map(number)).toEqual([2, 0, 1, 0]);
    for (const point of decisions) {
      expect(scalar(point, 2)).toBeGreaterThan(0n);
      expect(scalar(point, 3)).toBeGreaterThanOrEqual(
        scalar(point, 2) as bigint
      );
    }
    const gauge = nested(catalog["symphony.tokens.total"]!, 5)[0]!;
    expect(scalar(gauge, 2)).toBeUndefined(); // no gauge temporality
    const tokens = nested(gauge, 1);
    expect(tokens.map(number)).toEqual([10, 5, 15]);
    expect(tokens.map((point) => attributes(point, 7))).toEqual([
      { direction: "input", runtime: "codex" },
      { direction: "output", runtime: "codex" },
      { direction: "total", runtime: "codex" },
    ]);
    const histogram = nested(catalog["symphony.tick.duration"]!, 9)[0]!;
    expect(scalar(histogram, 2)).toBe(2n);
    const duration = nested(histogram, 1)[0]!;
    expect(scalar(duration, 4)).toBe(1n);
    expect(attributes(duration, 9)).toEqual({ outcome: "success" });
    const bounds = scalar(duration, 7) as Buffer;
    expect(
      Array.from({ length: bounds.length / 8 }, (_, i) =>
        bounds.readDoubleLE(i * 8)
      )
    ).toEqual([0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120]);
    await p.collect();
    expect(nested(nested(fields(received[2]!.bytes), 1)[0]!, 2)).toHaveLength(
      1
    );
    const nextScope = nested(nested(fields(received[2]!.bytes), 1)[0]!, 2).find(
      (scope) => text(nested(scope, 1)[0]!, 1) === "gh-symphony.orchestrator"
    )!;
    const next = nested(nextScope, 2).find(
      (m) => text(m, 1) === "symphony.tick.outcomes"
    )!;
    expect(nested(nested(next, 7)[0]!, 1).map(number)).toEqual([2, 0, 1, 0]);
  } finally {
    await p.shutdown(Date.now() + 5000);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

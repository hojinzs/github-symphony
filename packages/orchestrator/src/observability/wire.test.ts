import http from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createLogPipeline } from "./log-pipeline.js";
import { requestProtobuf } from "./transport.js";

// Independent protobuf wire decoder for the schema field IDs in official proto
// v1.9.0: collector/logs/v1/logs_service.proto, logs/v1/logs.proto, common/v1/common.proto.
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

describe("OT-01 real HTTP/protobuf Logs wire", () => {
  it("sends auth, resource, scope, explicit timestamps and severities in bounded batches", async () => {
    const received: {
      bytes: Buffer;
      headers: http.IncomingHttpHeaders;
      path: string | undefined;
    }[] = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({
        bytes: Buffer.concat(chunks),
        headers: req.headers,
        path: req.url,
      });
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const pipeline = createLogPipeline(
      {
        version: "1.2.3",
        projectId: "folder",
        projectSlug: "owner/repo",
        trackerKind: "github",
      },
      {
        endpoint: `http://127.0.0.1:${port}/v1/logs`,
        headers: { authorization: "Bearer test-only" },
      }
    );
    try {
      const kinds = ["run-failed", "run-retried", "run-dispatched"];
      for (let i = 0; i < 300; i++)
        pipeline.offerEvent(
          {
            at: "2026-10-07T00:00:00Z",
            event: kinds[i % 3]!,
            error: "[REDACTED]",
          },
          {
            observedAt: "2026-10-07T00:00:01Z",
            runId: "run-1",
            integrity: "digest",
          }
        );
      await pipeline.flush(Date.now() + 5000);
      expect(received).toHaveLength(2);
      const severities: bigint[] = [];
      const ids = new Set<string>();
      let records = 0;
      for (const request of received) {
        expect(request.path).toBe("/v1/logs");
        expect(request.headers.authorization).toBe("Bearer test-only");
        expect(request.headers["content-type"]).toBe("application/x-protobuf");
        expect(Number(request.headers["content-length"])).toBe(
          request.bytes.length
        );
        expect(request.bytes.length).toBeLessThanOrEqual(1024 * 1024);
        let batchRecords = 0;
        for (const resourceLogs of nested(fields(request.bytes), 1)) {
          const resource = attributes(nested(resourceLogs, 1)[0]!, 1);
          expect(resource).toMatchObject({
            "service.name": "gh-symphony",
            "service.version": "1.2.3",
            "symphony.project.id": "folder",
            "symphony.project.slug": "owner/repo",
            "symphony.tracker.kind": "github",
          });
          ids.add(String(resource["service.instance.id"]!));
          for (const scopeLogs of nested(resourceLogs, 2)) {
            expect(text(nested(scopeLogs, 1)[0]!, 1)).toBe(
              "gh-symphony.orchestrator"
            );
            for (const log of nested(scopeLogs, 2)) {
              records++;
              batchRecords++;
              expect(scalar(log, 1)).toBe(1791331200000000000n);
              expect(scalar(log, 11)).toBe(1791331201000000000n);
              expect(scalar(log, 9)).toBeUndefined();
              const body = text(nested(log, 5)[0]!, 1);
              expect(kinds).toContain(body);
              expect(text(log, 3)).toBe(
                (
                  {
                    "run-failed": "ERROR",
                    "run-retried": "WARN",
                    "run-dispatched": "INFO",
                  } as Record<string, string>
                )[body]
              );
              severities.push(scalar(log, 2) as bigint);
              expect(attributes(log, 6)).toMatchObject({
                "symphony.run.id": "run-1",
                "symphony.event.integrity": "digest",
              });
            }
          }
        }
        expect(batchRecords).toBeLessThanOrEqual(256);
      }
      expect(records).toBe(300);
      expect(new Set(severities)).toEqual(new Set([9n, 13n, 17n]));
      expect(ids.size).toBe(1);
    } finally {
      await pipeline.shutdown(Date.now() + 5000);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("rejects oversized response echoes without exposing their contents", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("secret".repeat(20000));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        requestProtobuf(
          { endpoint: `http://127.0.0.1:${port}/v1/logs`, headers: {} },
          new Uint8Array(),
          new AbortController().signal
        )
      ).rejects.toThrow("exceeds limit");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

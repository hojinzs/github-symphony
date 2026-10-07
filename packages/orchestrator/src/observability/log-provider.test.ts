import { describe, expect, it } from "vitest";
import type {
  LogRecordProcessor,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { createOwnedLogProvider } from "./log-provider.js";
import { assertOtlpProductionCapability } from "./activation.js";

const identity = {
  version: "test-release",
  projectId: "folder-id",
  projectSlug: "owner/repo",
  trackerKind: "github",
};
function capture() {
  const records: ReadableLogRecord[] = [];
  const processor: LogRecordProcessor = {
    onEmit: (record) => {
      records.push(record);
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  return { records, processor };
}

describe("isolated Logs ownership", () => {
  it("accepts matching reserved identity without consuming the custom-key allowance", async () => {
    const owner = createOwnedLogProvider(
      {
        ...identity,
        attributes: {
          ...Object.fromEntries(
            Array.from({ length: 16 }, (_, i) => [`deployment${i}`, i])
          ),
          "service.name": "gh-symphony",
          "symphony.project.id": "folder-id",
        },
      },
      capture().processor
    );
    expect(owner.resource.attributes["service.name"]).toBe("gh-symphony");
    expect(owner.resource.attributes["deployment15"]).toBe(15);
    await owner.provider.shutdown();
  });
  it("retains explicit event times, severity, attributes and project resource", async () => {
    const { records, processor } = capture();
    const owner = createOwnedLogProvider(
      { ...identity, attributes: { deployment: "test" } },
      processor
    );
    owner.emit({
      timestamp: 1000,
      observedTimestamp: 2000,
      severityNumber: 17,
      severityText: "ERROR",
      body: "run-failed",
      attributes: {
        "symphony.run.id": "run-1",
        "symphony.event.payload": "x".repeat(16384),
      },
    });
    expect(records).toHaveLength(1);
    expect({
      hrTime: records[0]!.hrTime,
      hrTimeObserved: records[0]!.hrTimeObserved,
      severityNumber: records[0]!.severityNumber,
      severityText: records[0]!.severityText,
      body: records[0]!.body,
      attributes: records[0]!.attributes,
    }).toMatchObject({
      hrTime: [1, 0],
      hrTimeObserved: [2, 0],
      severityNumber: 17,
      severityText: "ERROR",
      body: "run-failed",
      attributes: {
        "symphony.run.id": "run-1",
        "symphony.event.payload": "x".repeat(16384),
      },
    });
    expect(records[0]!.resource.attributes).toMatchObject({
      "service.name": "gh-symphony",
      "service.version": "test-release",
      "symphony.project.id": "folder-id",
      "symphony.project.slug": "owner/repo",
      "symphony.tracker.kind": "github",
      deployment: "test",
    });
    expect(records[0]!.spanContext).toBeUndefined();
    await owner.provider.shutdown();
  });
  it("gives each owner a distinct process incarnation", async () => {
    const first = createOwnedLogProvider(identity, capture().processor);
    const second = createOwnedLogProvider(identity, capture().processor);
    expect(first.resource.attributes["service.instance.id"]).toMatch(
      /^[0-9a-f-]{36}$/
    );
    expect(first.resource.attributes["service.instance.id"]).not.toBe(
      second.resource.attributes["service.instance.id"]
    );
    await Promise.all([first.provider.shutdown(), second.provider.shutdown()]);
  });
  it.each([
    { "service.name": "secret" },
    { "symphony.run.id": "secret" },
    { invalid: Infinity },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, i])),
  ])(
    "rejects unsafe resource overrides without echoing values: %s",
    (attributes) => {
      expect(() =>
        createOwnedLogProvider({ ...identity, attributes }, capture().processor)
      ).toThrow(/OTLP/);
      try {
        createOwnedLogProvider(
          { ...identity, attributes },
          capture().processor
        );
      } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    }
  );
  it("rejects production partial activation and accepts disabled policy", () => {
    expect(() => assertOtlpProductionCapability(true)).toThrow("unsupported");
    expect(() => assertOtlpProductionCapability(false)).not.toThrow();
  });
});

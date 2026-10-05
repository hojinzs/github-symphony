import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown, WorkflowValidationError } from "./parser.js";
import { parseOtlpPolicy } from "./otlp.js";

describe("structural OTLP policy", () => {
  it("parses enabled policy without reading exporter values", () => {
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error("environment accessed");
        },
      }
    );
    const workflow = parseWorkflowMarkdown(
      `---
observability:
  otlp:
    enabled: true
    endpoint: env:BASE
    headers:
      Authorization: $TOKEN
    metrics:
      endpoint: $METRICS
    resource_attributes:
      deployment: env:DEPLOYMENT
---
Prompt`,
      env
    );
    expect(workflow.observability?.otlp).toMatchObject({
      enabled: true,
      endpoint: "env:BASE",
      headers: { Authorization: "$TOKEN" },
      metrics: { endpoint: "$METRICS" },
      resourceAttributes: { deployment: "env:DEPLOYMENT" },
      referenceNames: ["BASE", "DEPLOYMENT", "METRICS", "TOKEN"],
      authReferenceNames: ["TOKEN"],
    });
  });

  it("defaults to disabled and retains disabled auth provenance", () => {
    expect(parseOtlpPolicy(undefined)).toBeNull();
    expect(parseOtlpPolicy({ otlp: {} })?.enabled).toBe(false);
    expect(
      parseOtlpPolicy({ otlp: { enabled: false, headers: "env:MISSING" } })
    ).toMatchObject({ enabled: false, authReferenceNames: ["MISSING"] });
  });

  it("preserves resource scalar types and explicit empty headers", () => {
    expect(
      parseOtlpPolicy({
        otlp: {
          protocol: "http/protobuf",
          headers: {},
          resource_attributes: { text: "staging", bool: false, num: 1.5 },
        },
      })
    ).toMatchObject({
      protocol: "http/protobuf",
      headers: {},
      resourceAttributes: { text: "staging", bool: false, num: 1.5 },
    });
  });

  it.each([
    null,
    [],
    { extra: true },
    { otlp: null },
    { otlp: [] },
    { otlp: { unknown: true } },
    { otlp: { enabled: "true" } },
    { otlp: { endpoint: 42 } },
    { otlp: { endpoint: "" } },
    { otlp: { endpoint: "env:bad-name" } },
    { otlp: { endpoint: "Bearer ${TOKEN}" } },
    { otlp: { protocol: "grpc" } },
    { otlp: { headers: "literal" } },
    { otlp: { headers: { Authorization: "secret" } } },
    { otlp: { headers: { Host: "env:HOST" } } },
    { otlp: { headers: { "Bad Header": "env:VALUE" } } },
    { otlp: { headers: { A: "$ONE", a: "$TWO" } } },
    { otlp: { logs: { unsupported: true } } },
    { otlp: { metrics: false } },
    ...[null, [], {}, Infinity].map((value) => ({
      otlp: { resource_attributes: { key: value } },
    })),
  ])("rejects invalid structure %# without inspecting values", (value) => {
    expect(() => parseOtlpPolicy(value)).toThrow(WorkflowValidationError);
  });
});

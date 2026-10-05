import { describe, expect, it } from "vitest";
import { parseOtlpPolicy } from "./otlp.js";
import { resolveOtlpConfiguration } from "./otlp-resolver.js";
import { WorkflowValidationError } from "./parser.js";

const policy = (value: Record<string, unknown> = {}) =>
  parseOtlpPolicy({ otlp: { enabled: true, ...value } });
const generalEnv = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/tenant/",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20general",
};

describe("owner-only OTLP resolution", () => {
  it.each([
    null,
    policy({ enabled: false, endpoint: "$MISSING", headers: "$SECRET" }),
    parseOtlpPolicy({ otlp: {} }),
  ])("never activates on ambient settings %#", (raw) => {
    const result = resolveOtlpConfiguration(raw, {
      ...generalEnv,
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    });
    expect(result).toMatchObject({
      enabled: false,
      logs: null,
      metrics: null,
      diagnostics: { enabled: false, disabledReason: "workflow", signals: {} },
    });
  });

  it("SDK_DISABLED veto avoids resolving missing references and retains auth names", () => {
    const result = resolveOtlpConfiguration(
      policy({ endpoint: "$MISSING", headers: "$SECRET" }),
      {
        OTEL_SDK_DISABLED: "TRUE",
        OTEL_EXPORTER_OTLP_PROTOCOL: "invalid",
      }
    );
    expect(result).toMatchObject({
      enabled: false,
      logs: null,
      metrics: null,
      diagnostics: {
        disabledReason: "sdk-disabled",
        authReferenceNames: ["SECRET"],
      },
    });
  });

  it("general endpoints append signal paths while signal URLs remain exact", () => {
    expect(resolveOtlpConfiguration(policy(), generalEnv)).toMatchObject({
      logs: {
        endpoint: "https://collector.example/tenant/v1/logs",
        protocol: "http/protobuf",
      },
      metrics: { endpoint: "https://collector.example/tenant/v1/metrics" },
    });
    expect(
      resolveOtlpConfiguration(
        policy({
          logs: { endpoint: "https://logs.example" },
          metrics: { endpoint: "https://metrics.example/custom" },
        }),
        {}
      )
    ).toMatchObject({
      logs: { endpoint: "https://logs.example/" },
      metrics: { endpoint: "https://metrics.example/custom" },
    });
  });

  it("signal YAML beats general YAML, which beats signal environment", () => {
    const result = resolveOtlpConfiguration(
      policy({
        endpoint: "$BASE",
        protocol: "http/protobuf",
        headers: { Authorization: "env:AUTH" },
        logs: { endpoint: "${LOGS}", headers: {} },
      }),
      {
        BASE: "https://yaml.example/base",
        LOGS: "https://yaml.example/exact",
        AUTH: "Bearer private",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://ignored.example",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://ignored.example",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc",
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc",
        ...generalEnv,
      }
    );
    expect(result.logs).toEqual({
      endpoint: "https://yaml.example/exact",
      protocol: "http/protobuf",
      headers: {},
    });
    expect(result.metrics).toEqual({
      endpoint: "https://yaml.example/base/v1/metrics",
      protocol: "http/protobuf",
      headers: { Authorization: "Bearer private" },
    });
    expect(result.diagnostics.signals.metrics?.headerNames).toEqual([
      "Authorization",
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("private");
  });

  it("signal environment beats general environment and replaces whole header maps", () => {
    const result = resolveOtlpConfiguration(policy(), {
      ...generalEnv,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://signal.example/custom",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "X-Tenant=signal",
    });
    expect(result.logs).toEqual({
      endpoint: "https://signal.example/custom",
      protocol: "http/protobuf",
      headers: { "X-Tenant": "signal" },
    });
    expect(result.metrics?.headers).toEqual({
      Authorization: "Bearer general",
    });
  });

  it("merges YAML over environment resources and resolves scalar references", () => {
    const result = resolveOtlpConfiguration(
      policy({
        resource_attributes: {
          region: "west",
          deployment: "$DEPLOYMENT",
          count: 2,
          active: true,
        },
      }),
      {
        ...generalEnv,
        OTEL_RESOURCE_ATTRIBUTES: "region=east,deployment=production",
        DEPLOYMENT: "staging",
      }
    );
    expect(result.resourceAttributes).toEqual({
      region: "west",
      deployment: "staging",
      count: 2,
      active: true,
    });
    expect(result.diagnostics.resourceAttributes).toEqual(
      result.resourceAttributes
    );
  });

  it.each([
    ["build", "ZmFrZV9iYXNlNjRfYnV0X3JlYWxpc3RpY19sb29raW5nMTIz"],
    ["secret", "private-resource-value"],
  ])(
    "identifies rejected resource key %s without exposing its value",
    (key, value) => {
      for (const source of ["yaml", "environment"]) {
        const raw =
          source === "yaml"
            ? { resource_attributes: { region: "east", [key]: value } }
            : {};
        const env =
          source === "environment"
            ? {
                ...generalEnv,
                OTEL_RESOURCE_ATTRIBUTES: `region=east,${key}=${value}`,
              }
            : generalEnv;
        expect(() => resolveOtlpConfiguration(policy(raw), env)).toThrow(
          `must not contain secrets (attribute "${key}")`
        );
        try {
          resolveOtlpConfiguration(policy(raw), env);
        } catch (error) {
          expect(String(error)).not.toContain(value);
          expect(String(error)).not.toContain('attribute "region"');
        }
      }
    }
  );

  it("lists unsupported environment names without their values", () => {
    const result = resolveOtlpConfiguration(null, {
      OTEL_LOGS_EXPORTER: "private",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "private",
    });
    expect(result.diagnostics.unsupportedEnvironmentNames).toEqual([
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_LOGS_EXPORTER",
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    [{}, {}],
    [{ endpoint: "$ABSENT" }, {}],
    [{ endpoint: "env:EMPTY" }, { EMPTY: "" }],
    [{ endpoint: "https://user:private@collector.example" }, {}],
    [{ endpoint: "https://collector.example?private=value" }, {}],
    [{ endpoint: "https://collector.example#private" }, {}],
    [{ endpoint: "ftp://collector.example" }, {}],
    [{}, { OTEL_EXPORTER_OTLP_ENDPOINT: "" }],
    [{}, { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", ...generalEnv }],
    [{}, { OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "", ...generalEnv }],
    [{ headers: "$ABSENT" }, generalEnv],
    [
      { headers: { Authorization: "$AUTH" } },
      { ...generalEnv, AUTH: "private\r\nInjected: yes" },
    ],
    [{}, { ...generalEnv, OTEL_EXPORTER_OTLP_HEADERS: "A=one,a=two" }],
    [{}, { ...generalEnv, OTEL_EXPORTER_OTLP_HEADERS: "Host=private" }],
    [{}, { ...generalEnv, OTEL_EXPORTER_OTLP_HEADERS: "Content-Type=private" }],
    [{}, { ...generalEnv, OTEL_EXPORTER_OTLP_HEADERS: "malformed" }],
    [{}, { ...generalEnv, OTEL_EXPORTER_OTLP_HEADERS: "A=%ZZ" }],
    [{}, { ...generalEnv, OTEL_EXPORTER_OTLP_HEADERS: "A=private%0A" }],
    [{}, { ...generalEnv, OTEL_EXPORTER_OTLP_HEADERS: "" }],
    [
      { resource_attributes: { secret: "$RESOURCE" } },
      { ...generalEnv, RESOURCE: "private" },
    ],
  ] as [Record<string, unknown>, NodeJS.ProcessEnv][])(
    "rejects enabled invalid resolution without leaking values %#",
    (raw, env) => {
      expect(() => resolveOtlpConfiguration(policy(raw), env)).toThrow(
        WorkflowValidationError
      );
      try {
        resolveOtlpConfiguration(policy(raw), env);
      } catch (error) {
        expect(String(error)).not.toContain("private");
      }
    }
  );
});

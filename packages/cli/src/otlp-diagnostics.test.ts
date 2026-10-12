import { afterEach, expect, it, vi } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import { inspectOtlp, renderOtlpStatus } from "./otlp-diagnostics.js";

const policy = () =>
  parseWorkflowMarkdown(`---
observability:
  otlp:
    enabled: true
    endpoint: http://localhost:4318
    headers:
      Authorization: $COLLECTOR_SECRET
---
prompt`).observability!.otlp;

afterEach(() => vi.useRealTimers());

it("never connects for disabled policy, omission or SDK veto", async () => {
  const request = vi.fn();
  for (const raw of [undefined, { ...policy(), enabled: false }, policy()]) {
    const result = await inspectOtlp(
      raw,
      { OTEL_SDK_DISABLED: "true" },
      true,
      request
    );
    expect(result.configuration.enabled).toBe(false);
    expect(result.probe).toEqual({});
  }
  expect(request).not.toHaveBeenCalled();
});

it("validates without connecting and exposes names without credentials", async () => {
  const request = vi.fn();
  const result = await inspectOtlp(
    policy(),
    { COLLECTOR_SECRET: "private-value" },
    false,
    request
  );
  expect(result.configuration.signals.logs?.headerNames).toEqual([
    "Authorization",
  ]);
  expect(JSON.stringify(result)).not.toContain("private-value");
  expect(request).not.toHaveBeenCalled();
});

it("probes both signals with bounded requests and safe HTTP outcomes", async () => {
  const request = vi.fn(
    async () => new Response("secret remote response", { status: 401 })
  );
  const result = await inspectOtlp(
    policy(),
    { COLLECTOR_SECRET: "private-value" },
    true,
    request
  );
  expect(result.probe).toEqual({ logs: "HTTP 401", metrics: "HTTP 401" });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]).toEqual([
    "http://localhost:4318/v1/logs",
    expect.objectContaining({ redirect: "error", method: "POST" }),
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /private-value|secret remote response/
  );
});

it("ends probes after three seconds even if a transport ignores abort", async () => {
  vi.useFakeTimers();
  const request = vi.fn(() => new Promise<Response>(() => {}));
  const pending = inspectOtlp(
    policy(),
    { COLLECTOR_SECRET: "private-value" },
    true,
    request
  );
  await vi.advanceTimersByTimeAsync(3000);
  expect((await pending).probe).toEqual({
    logs: "timeout",
    metrics: "timeout",
  });
});

it("renders applied and pending independently with an honest restart warning", async () => {
  const applied = (
    await inspectOtlp(policy(), { COLLECTOR_SECRET: "private-value" })
  ).configuration;
  const pending = { ...applied, enabled: false, signals: {} };
  const output = renderOtlpStatus({
    state: "healthy",
    applied,
    pending,
    restartRequired: true,
  }).join("\n");
  expect(output).toContain(
    "Applied: enabled · logs: http://localhost:4318/v1/logs"
  );
  expect(output).toContain("Pending: disabled");
  expect(output).toContain("applied exporter remains active until restart");
  expect(
    renderOtlpStatus({
      state: "healthy",
      applied,
      pending: null,
      restartRequired: false,
    }).join("\n")
  ).toContain("Pending: none");
  expect(renderOtlpStatus(undefined)).toEqual([]);
});

it("rejects disabled and SDK-vetoed shared credentials without reading values", async () => {
  const secretRead = vi.fn(() => {
    throw new Error("credential read");
  });
  const environment = { OTEL_SDK_DISABLED: "true" };
  Object.defineProperty(environment, "OPENAI_API_KEY", {
    get: secretRead,
    enumerable: true,
  });
  for (const enabled of [false, true]) {
    await expect(
      inspectOtlp(
        { ...policy()!, enabled, authReferenceNames: ["OPENAI_API_KEY"] },
        environment,
        true,
        vi.fn()
      )
    ).rejects.toThrow("conflicts with agent/tracker authentication");
  }
  expect(secretRead).not.toHaveBeenCalled();
});

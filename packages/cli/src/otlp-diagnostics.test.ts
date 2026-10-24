import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  parseWorkflowMarkdown,
  WorkflowValidationError,
  type WorkflowOtlpPolicy,
} from "@gh-symphony/core";
import {
  inspectOtlp,
  renderOtlpStatus,
  otlpValidationRemediation,
} from "./otlp-diagnostics.js";

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

it("keeps probe transports unloaded for rendering and validation", async () => {
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, next) {
        if (/^(node:)?https?$/.test(specifier) || specifier.startsWith("@opentelemetry/")) throw Error("FORBIDDEN_PROBE_TRANSPORT");
        return next(specifier, context);
      }});
      const { inspectOtlp, renderOtlpStatus } = await import(${JSON.stringify(new URL("./otlp-diagnostics.ts", import.meta.url).href)});
      renderOtlpStatus(undefined);
      await inspectOtlp(undefined, {}, true);
      await inspectOtlp({enabled:true, endpoint:"https://localhost:4318", resourceAttributes:{},referenceNames:[],authReferenceNames:[]}, {}, false);
      console.log("reached: transport-free diagnostics");
    `,
  ]);
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
  const code = await new Promise<number | null>((resolve) =>
    child.on("close", resolve)
  ).finally(() => clearTimeout(deadline));
  expect(output).not.toContain("FORBIDDEN_PROBE_TRANSPORT");
  expect(output).toContain("reached: transport-free diagnostics");
  expect(code).toBe(0);
});

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

it("releases stalled TLS sockets so the probe process exits within its budget", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
    import { inspectOtlp } from ${JSON.stringify(new URL("./otlp-diagnostics.ts", import.meta.url).href)};
    const result = await inspectOtlp({enabled:true, endpoint:"https://127.0.0.1:${address.port}", resourceAttributes:{},referenceNames:[],authReferenceNames:[]}, {}, true);
    console.log(JSON.stringify(result.probe));
  `,
    ],
    { env: { ...process.env, OTEL_SDK_DISABLED: "false" } }
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
  try {
    const code = await new Promise<number | null>((resolve) =>
      child.on("close", resolve)
    );
    expect(output).toContain('"logs":"timeout"');
    expect(output).toContain('"metrics":"timeout"');
    expect(code).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

const identity = {
  version: "1",
  instanceId: "owned",
  projectId: "p",
  projectSlug: "p",
  trackerKind: "file",
};

it.each([null, [], {}, NaN, Infinity, -Infinity].map((value) => [value]))(
  "shares resource type/finiteness rejection for %s",
  async (value) => {
    const { resolveProjectResourceAttributes } =
      await import("@gh-symphony/orchestrator/otlp-validation");
    const attributes = {
      custom: value,
    } as unknown as WorkflowOtlpPolicy["resourceAttributes"];
    expect(() =>
      resolveProjectResourceAttributes({ ...identity, attributes })
    ).toThrow("invalid or reserved");
    await expect(
      inspectOtlp(
        { ...policy()!, resourceAttributes: attributes },
        { COLLECTOR_SECRET: "secret" }
      )
    ).rejects.toThrow("invalid or reserved");
  }
);

it.each(["", "owned", "foreign"])(
  "reserves instance identity even for %s",
  async (value) => {
    const { resolveProjectResourceAttributes } =
      await import("@gh-symphony/orchestrator/otlp-validation");
    const attributes = { "service.instance.id": value };
    expect(() =>
      resolveProjectResourceAttributes({ ...identity, attributes })
    ).toThrow("invalid or reserved");
    await expect(
      inspectOtlp(
        { ...policy()!, resourceAttributes: attributes },
        { COLLECTOR_SECRET: "secret" }
      )
    ).rejects.toThrow("invalid or reserved");
  }
);

it("accepts finite scalar attributes and matching runtime identity", async () => {
  const result = await inspectOtlp(
    {
      ...policy()!,
      resourceAttributes: {
        number: 0,
        bool: false,
        text: "ok",
        "service.name": "gh-symphony",
      },
    },
    { COLLECTOR_SECRET: "secret" }
  );
  expect(result.configuration.enabled).toBe(true);
});

it("renders only typed value-free remediation and keeps unknown failures generic", async () => {
  const { OtlpValidationError } =
    await import("@gh-symphony/orchestrator/otlp-validation");
  const reasons = [
    "credential-ownership",
    "resource-limit",
    "resource-attribute",
  ] as const;
  for (const reason of reasons) {
    const remediation = otlpValidationRemediation(
      new OtlpValidationError(reason)
    );
    expect(remediation).toMatch(/distinct exporter|16 custom|finite scalar/);
  }
  for (const [path, expected] of [
    ["observability.otlp.endpoint", "HTTP(S)"],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"],
    ["observability.otlp.headers", "unique OTLP headers"],
    ["unknown", "configuration types"],
  ]) {
    const remediation = otlpValidationRemediation(
      new WorkflowValidationError(
        "workflow_validation_error",
        path!,
        "https://user:password@host/?token=secret Authorization=header-secret"
      )
    );
    expect(remediation).toContain(expected);
    expect(JSON.stringify({ remediation })).not.toMatch(
      /password|token=secret|header-secret/
    );
  }
  expect(otlpValidationRemediation(new Error("header-secret"))).toBe(
    "Check observability.otlp and its referenced environment variables; credentials are not displayed."
  );
});

it.each([
  "OPENAI_API_KEY",
  "TRACKER_SECRET",
  "CUSTOM_AUTH",
  "ANTHROPIC_API_KEY",
])("shares credential ownership rejection for %s", async (name) => {
  const { validateExporterCredentialNames } =
    await import("@gh-symphony/orchestrator/otlp-validation");
  const raw = { ...policy()!, enabled: false, authReferenceNames: [name] };
  expect(() =>
    validateExporterCredentialNames(
      {
        observability: { otlp: raw },
        runtime: { auth: { env: "CUSTOM_AUTH" } },
      },
      ["TRACKER_SECRET"]
    )
  ).toThrow("distinct exporter credential name");
  await expect(
    inspectOtlp(raw, {}, true, vi.fn(), {
      trackerSecretNames: ["TRACKER_SECRET"],
      runtimeAuthName: "CUSTOM_AUTH",
    })
  ).rejects.toThrow("distinct exporter credential name");
});

it("reports discarded ambient keys in doctor and status without values", async () => {
  const result = await inspectOtlp(policy(), {
    COLLECTOR_SECRET: "secret",
    OTEL_SERVICE_NAME: "CANARY_AMBIENT",
    OTEL_RESOURCE_ATTRIBUTES:
      "service.instance.id=CANARY_AMBIENT,symphony.max_token=CANARY_AMBIENT",
  });
  expect(result.configuration.enabled).toBe(true);
  const text = renderOtlpStatus({
    state: "healthy",
    applied: result.configuration,
    pending: null,
    restartRequired: false,
  }).join("\n");
  expect(text).toContain(
    "Discarded ambient resource service.name: reserved identity"
  );
  expect(text).toContain(
    "Discarded ambient resource service.instance.id: reserved identity"
  );
  expect(text).toContain(
    "Discarded ambient resource symphony.max_token: secret-bearing attribute"
  );
  expect(JSON.stringify([result, text])).not.toContain("CANARY_AMBIENT");
});

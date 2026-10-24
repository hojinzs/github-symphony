import {
  validateExporterCredentialNames,
  resolveProjectResourceAttributes,
  OtlpValidationError,
} from "@gh-symphony/orchestrator/otlp-validation";
import {
  resolveOtlpConfiguration,
  WorkflowValidationError,
  type WorkflowOtlpPolicy,
  type OtlpSafeDescriptor,
} from "@gh-symphony/core";

// Own the request/socket instead of using fetch's shared connection pool.
// Abort must release a pending TLS handshake as well as settle the result.
const probeRequest: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  // Status rendering and validation share this module with probes. Keep TLS
  // initialization out of their startup path until a probe actually connects.
  const { request: send } = await (url.protocol === "https:"
    ? import("node:https")
    : import("node:http"));
  return new Promise<Response>((resolve, reject) => {
    const request = send(
      url,
      {
        method: "POST",
        headers: Object.fromEntries(new Headers(init?.headers)),
        agent: false,
      },
      (response) => {
        // Only the status is diagnostic; never retain a receiver response body.
        response.destroy();
        resolve(new Response(null, { status: response.statusCode ?? 500 }));
      }
    );
    const abort = () => request.destroy(new Error("Probe aborted"));
    request.on("error", reject);
    request.on("close", () =>
      init?.signal?.removeEventListener("abort", abort)
    );
    init?.signal?.addEventListener("abort", abort, { once: true });
    if (init?.signal?.aborted) abort();
    else request.end();
  });
};

/** SDK-free diagnostics. Never return transport credentials or remote bodies. */
export async function inspectOtlp(
  policy: WorkflowOtlpPolicy | null | undefined,
  environment: NodeJS.ProcessEnv,
  probe = false,
  fetchImpl: typeof fetch = probeRequest,
  owner: {
    trackerSecretNames?: readonly string[];
    runtimeAuthName?: string;
    resourceIdentity?: Record<string, string>;
  } = {}
) {
  validateExporterCredentialNames(
    {
      observability: { otlp: policy },
      runtime: { auth: { env: owner.runtimeAuthName } },
    },
    owner.trackerSecretNames ?? []
  );
  const resolved = resolveOtlpConfiguration(policy, environment);
  if (resolved.enabled) {
    // An unresolved project has no known identity. Empty defaults conservatively
    // keep runtime-owned project keys reserved instead of allowing overrides.
    const identity = owner.resourceIdentity ?? {};
    resolveProjectResourceAttributes({
      version: identity["service.version"] ?? "",
      projectId: identity["symphony.project.id"] ?? "",
      projectSlug: identity["symphony.project.slug"] ?? "",
      trackerKind: identity["symphony.tracker.kind"] ?? "",
      attributes: resolved.resourceAttributes,
    });
  }
  const outcomes: Partial<Record<"logs" | "metrics", string>> = {};
  if (probe && resolved.enabled) {
    await Promise.all(
      (["logs", "metrics"] as const).map(async (signal) => {
        const destination = resolved[signal]!;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            fetchImpl(destination.endpoint, {
              method: "POST",
              headers: {
                ...destination.headers,
                "Content-Type": "application/x-protobuf",
              },
              // Empty Export request: no fabricated events or measurements.
              body: new Uint8Array(),
              redirect: "error",
              signal: controller.signal,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("timeout"));
              }, 3000);
            }),
          ]);
          outcomes[signal] = `HTTP ${response.status}`;
          void response.body?.cancel().catch(() => {});
        } catch {
          outcomes[signal] = controller.signal.aborted
            ? "timeout"
            : "connection failed";
        } finally {
          clearTimeout(timer);
        }
      })
    );
  }
  return { configuration: resolved.diagnostics, probe: outcomes };
}

type TelemetryView = {
  state: string;
  applied: OtlpSafeDescriptor;
  pending: OtlpSafeDescriptor | null;
  restartRequired: boolean;
};

export function renderOtlpStatus(
  telemetry: TelemetryView | undefined
): string[] {
  if (!telemetry) return [];
  const describe = (value: OtlpSafeDescriptor) =>
    `${value.enabled ? "enabled" : "disabled"}${Object.entries(value.signals)
      .map(([name, signal]) => ` · ${name}: ${signal.endpoint}`)
      .join("")}`;
  return [
    `  OTLP: ${telemetry.state}`,
    `    Applied: ${describe(telemetry.applied)}`,
    `    Pending: ${telemetry.pending ? describe(telemetry.pending) : "none"}`,
    ...[telemetry.applied, telemetry.pending].flatMap((value) =>
      (value?.discardedEnvironmentResources ?? []).map(
        ({ key, reason }) => `    Discarded ambient resource ${key}: ${reason}`
      )
    ),
    ...(telemetry.restartRequired
      ? [
          "    Restart required; the applied exporter remains active until restart.",
        ]
      : []),
    "",
  ];
}

/** Only typed failures are actionable; never interpolate arbitrary error text. */
export function otlpValidationRemediation(error: unknown): string {
  if (error instanceof OtlpValidationError) return error.message;
  if (error instanceof WorkflowValidationError) {
    if (/(?:^|[._])endpoint$/i.test(error.path))
      return "Set a valid HTTP(S) OTLP endpoint without user information, query or fragment; check its referenced environment variable.";
    if (/(?:^|[._])protocol$/i.test(error.path))
      return "Set the OTLP protocol to http/protobuf.";
    if (/(?:^|[._])headers$/i.test(error.path))
      return "Set valid, unique OTLP headers and check referenced environment variables; avoid reserved headers and line breaks.";
    return "Check OTLP configuration types and referenced environment variables; credentials are not displayed.";
  }
  return "Check observability.otlp and its referenced environment variables; credentials are not displayed.";
}

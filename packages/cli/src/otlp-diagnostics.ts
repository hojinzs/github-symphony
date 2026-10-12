import {
  resolveOtlpConfiguration,
  isAgentChildCredentialEnvironmentName,
  type WorkflowOtlpPolicy,
  type OtlpSafeDescriptor,
} from "@gh-symphony/core";

/** SDK-free diagnostics. Never return transport credentials or remote bodies. */
export async function inspectOtlp(
  policy: WorkflowOtlpPolicy | null | undefined,
  environment: NodeJS.ProcessEnv,
  probe = false,
  fetchImpl: typeof fetch = fetch,
  owner: {
    trackerSecretNames?: readonly string[];
    runtimeAuthName?: string;
    resourceIdentity?: Record<string, string>;
  } = {}
) {
  // Match H's name-only startup check before reading values or contacting a
  // receiver. Keep this CLI diagnostic boundary SDK-free and package-local.
  const names = new Set(policy?.authReferenceNames ?? []);
  const required = new Set([
    ...(owner.trackerSecretNames ?? []),
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "SYMPHONY_ORCHESTRATOR_TOKEN",
    ...(owner.runtimeAuthName ? [owner.runtimeAuthName] : []),
  ]);
  for (const name of new Set([...names, ...required])) {
    if (
      (names.has(name) &&
        (required.has(name) || isAgentChildCredentialEnvironmentName(name))) ||
      (required.has(name) &&
        /^OTEL_EXPORTER_OTLP_(?:(?:LOGS|METRICS|TRACES)_)?(?:HEADERS|CLIENT_KEY|CLIENT_CERTIFICATE)$/.test(
          name
        ))
    ) {
      throw new Error(
        "Exporter credential reference conflicts with agent/tracker authentication"
      );
    }
  }
  const resolved = resolveOtlpConfiguration(policy, environment);
  if (resolved.enabled) {
    const reserved: Record<string, string> = {
      "service.name": "gh-symphony",
      ...owner.resourceIdentity,
    };
    const custom = resolved.resourceAttributes;
    if (
      Object.keys(custom).filter((key) => !Object.hasOwn(reserved, key))
        .length > 16
    )
      throw new Error("OTLP resource permits at most 16 custom attributes");
    for (const [key, value] of Object.entries(custom)) {
      if (
        key === "service.instance.id" ||
        (Object.hasOwn(reserved, key) &&
          reserved[key as keyof typeof reserved] !== value) ||
        /(?:^|\.)(?:issue|run|session|turn)(?:\.|$)/i.test(key)
      ) {
        throw new Error(
          "OTLP custom resource attribute is invalid or reserved"
        );
      }
    }
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
    ...(telemetry.restartRequired
      ? [
          "    Restart required; the applied exporter remains active until restart.",
        ]
      : []),
    "",
  ];
}

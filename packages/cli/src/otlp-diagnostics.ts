import {
  resolveOtlpConfiguration,
  type WorkflowOtlpPolicy,
  type OtlpSafeDescriptor,
} from "@gh-symphony/core";

/** SDK-free diagnostics. Never return transport credentials or remote bodies. */
export async function inspectOtlp(
  policy: WorkflowOtlpPolicy | null | undefined,
  environment: NodeJS.ProcessEnv,
  probe = false,
  fetchImpl: typeof fetch = fetch
) {
  const resolved = resolveOtlpConfiguration(policy, environment);
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

/** SDK-free production guard. The complete pipeline and packaged audits are
 * prerequisites to enabling YAML policy; this slice is injection-only.
 */
export function assertOtlpProductionCapability(enabled: boolean): void {
  if (enabled) {
    throw new Error(
      "OTLP production activation is unsupported until the complete pipeline passes packaged audits"
    );
  }
}

/** Internal injection is explicit, never inferred from YAML or environment.
 * Disabled owners keep the entire SDK/transport graph unevaluated.
 */
export async function initializeLogs(
  enabled: boolean,
  injected?: {
    identity: import("./log-provider.js").ProjectResourceIdentity;
    destination: import("./transport.js").LogDestination;
    options?: Parameters<
      typeof import("./log-pipeline.js").createLogPipeline
    >[2];
  }
): Promise<
  ReturnType<typeof import("./log-pipeline.js").createLogPipeline> | undefined
> {
  if (!enabled) return undefined;
  if (!injected) {
    assertOtlpProductionCapability(enabled);
    return undefined;
  }
  const { createLogPipeline } = await import("./log-pipeline.js");
  return createLogPipeline(
    injected.identity,
    injected.destination,
    injected.options
  );
}

/** Metrics retain the same explicit injection-only production gate as Logs. */
export async function initializeMetrics(
  enabled: boolean,
  injected?: {
    identity: import("./resource.js").ProjectResourceIdentity;
    destination: import("./transport.js").LogDestination;
    options?: Parameters<
      typeof import("./metric-pipeline.js").createMetricPipeline
    >[2];
  }
): Promise<
  | ReturnType<typeof import("./metric-pipeline.js").createMetricPipeline>
  | undefined
> {
  if (!enabled) return undefined;
  if (!injected) {
    assertOtlpProductionCapability(enabled);
    return undefined;
  }
  const { createMetricPipeline } = await import("./metric-pipeline.js");
  return createMetricPipeline(
    injected.identity,
    injected.destination,
    injected.options
  );
}

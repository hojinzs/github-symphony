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

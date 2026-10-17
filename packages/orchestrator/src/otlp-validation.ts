/** Public SDK-free owner-side validation boundary. */
export {
  OtlpValidationError,
  type OtlpValidationReason,
} from "./otlp-validation-error.js";
export { validateExporterCredentialNames } from "./exporter-environment.js";
export { resolveProjectResourceAttributes } from "./observability/resource-validation.js";

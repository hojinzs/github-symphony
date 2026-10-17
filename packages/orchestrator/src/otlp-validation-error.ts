import { WorkflowValidationError } from "@gh-symphony/core";

export type OtlpValidationReason =
  | "credential-ownership"
  | "resource-limit"
  | "resource-attribute";

const messages: Record<OtlpValidationReason, string> = {
  "credential-ownership":
    "Exporter credential reference conflicts with agent/tracker authentication; use a distinct exporter credential name.",
  "resource-limit": "OTLP resource permits at most 16 custom attributes.",
  "resource-attribute":
    "OTLP custom resource attribute is invalid or reserved; use finite scalar values and preserve runtime identity.",
};

/** Fixed reasons contain no configuration values, keys or credential names. */
export class OtlpValidationError extends WorkflowValidationError {
  constructor(public readonly reason: OtlpValidationReason) {
    super("workflow_validation_error", "observability.otlp", messages[reason]);
  }
}

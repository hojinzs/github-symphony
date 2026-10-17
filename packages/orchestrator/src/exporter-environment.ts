import {
  isAgentChildCredentialEnvironmentName,
  type WorkflowOtlpPolicy,
} from "@gh-symphony/core";

import { OtlpValidationError } from "./otlp-validation-error.js";

/** Validate name-only ownership, then return exporter references for stripping. */
export function validateExporterCredentialNames(
  workflow: {
    observability?: { otlp?: WorkflowOtlpPolicy | null } | null;
    runtime?: { auth: { env?: string | null } } | null;
  },
  trackerSecretNames: readonly string[],
  retainedNames: ReadonlySet<string> = new Set()
): ReadonlySet<string> {
  const names = new Set([
    ...(workflow.observability?.otlp?.authReferenceNames ?? []),
    ...retainedNames,
  ]);
  const required = new Set([
    ...trackerSecretNames,
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "SYMPHONY_ORCHESTRATOR_TOKEN",
    ...(workflow.runtime?.auth.env ? [workflow.runtime.auth.env] : []),
  ]);
  for (const name of new Set([...required, ...names])) {
    if (
      (names.has(name) &&
        (required.has(name) || isAgentChildCredentialEnvironmentName(name))) ||
      (required.has(name) && isExporterCredentialName(name))
    ) {
      throw new OtlpValidationError("credential-ownership");
    }
  }
  return names;
}

function isExporterCredentialName(name: string): boolean {
  return /^OTEL_EXPORTER_OTLP_(?:(?:LOGS|METRICS|TRACES)_)?(?:HEADERS|CLIENT_KEY|CLIENT_CERTIFICATE)$/.test(
    name
  );
}

/** Apply after every project, inherited and explicit environment merge. */
export function stripExporterCredentials(
  environment: Record<string, string | undefined>,
  names: ReadonlySet<string> = new Set()
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !names.has(entry[0]) &&
        !isExporterCredentialName(entry[0])
    )
  );
}

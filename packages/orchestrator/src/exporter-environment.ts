import {
  WorkflowValidationError,
  isAgentChildCredentialEnvironmentName,
  type WorkflowDefinition,
} from "@gh-symphony/core";

/** Credential ownership is determined by names, even while OTLP is disabled. */
export function exporterCredentialNames(
  workflow: WorkflowDefinition,
  trackerSecretNames: readonly string[]
): ReadonlySet<string> {
  const names = new Set(workflow.observability?.otlp?.authReferenceNames ?? []);
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
      throw new WorkflowValidationError(
        "workflow_validation_error",
        "observability.otlp.headers",
        `Exporter credential reference ${JSON.stringify(name)} conflicts with agent/tracker authentication; use a distinct exporter credential name.`
      );
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

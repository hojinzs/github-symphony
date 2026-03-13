import type { TenantStatusSnapshot } from "@gh-symphony/core";

/**
 * Client-side alias for the orchestrator status snapshot.
 *
 * The orchestrator status API serializes `TenantStatusSnapshot` from
 * `@gh-symphony/core` as JSON. This re-export keeps the control-plane
 * client aligned with the spec-level status surface without duplicating
 * the type definition.
 */
export type OrchestratorTenantStatusSnapshot = TenantStatusSnapshot;

export function resolveOrchestratorStatusBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHESTRATOR_STATUS_BASE_URL ?? "http://127.0.0.1:4680";
}

export async function fetchTenantOrchestratorStatus(
  tenantId: string,
  dependencies: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
  } = {}
): Promise<OrchestratorTenantStatusSnapshot | null> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${dependencies.baseUrl ?? resolveOrchestratorStatusBaseUrl()}/api/v1/tenants/${encodeURIComponent(
      tenantId
    )}/status`
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Orchestrator status endpoint returned ${response.status}`);
  }

  return (await response.json()) as OrchestratorTenantStatusSnapshot;
}

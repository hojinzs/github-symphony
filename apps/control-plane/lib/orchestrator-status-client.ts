import type { ProjectStatusSnapshot } from "@gh-symphony/core";

/**
 * Client-side alias for the orchestrator status snapshot.
 *
 * The orchestrator status API serializes `ProjectStatusSnapshot` from
 * `@gh-symphony/core` as JSON. This re-export keeps the control-plane
 * client aligned with the spec-level status surface without duplicating
 * the type definition.
 */
export type OrchestratorProjectStatusSnapshot = ProjectStatusSnapshot;

export function resolveOrchestratorStatusBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHESTRATOR_STATUS_BASE_URL ?? "http://127.0.0.1:4680";
}

export async function fetchProjectOrchestratorStatus(
  projectId: string,
  dependencies: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
  } = {}
): Promise<OrchestratorProjectStatusSnapshot | null> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${dependencies.baseUrl ?? resolveOrchestratorStatusBaseUrl()}/api/v1/status`
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Orchestrator status endpoint returned ${response.status}`);
  }

  const snapshot = (await response.json()) as OrchestratorProjectStatusSnapshot;
  return snapshot.projectId === projectId ? snapshot : null;
}

export type OrchestratorWorkspaceStatusSnapshot = {
  workspaceId: string;
  slug: string;
  tracker: {
    adapter: string;
    bindingId: string;
  };
  lastTickAt: string;
  health: "idle" | "running" | "degraded";
  summary: {
    dispatched: number;
    suppressed: number;
    recovered: number;
    activeRuns: number;
  };
  activeRuns: Array<{
    runId: string;
    issueIdentifier: string;
    phase: string;
    status: string;
    retryKind: string | null;
    port: number | null;
  }>;
  retryQueue: Array<{
    runId: string;
    issueIdentifier: string;
    retryKind: string;
    nextRetryAt: string | null;
  }>;
  lastError: string | null;
};

export function resolveOrchestratorStatusBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHESTRATOR_STATUS_BASE_URL ?? "http://127.0.0.1:4680";
}

export async function fetchWorkspaceOrchestratorStatus(
  workspaceId: string,
  dependencies: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
  } = {}
): Promise<OrchestratorWorkspaceStatusSnapshot | null> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${dependencies.baseUrl ?? resolveOrchestratorStatusBaseUrl()}/api/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/status`
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Orchestrator status endpoint returned ${response.status}`);
  }

  return (await response.json()) as OrchestratorWorkspaceStatusSnapshot;
}

import { db } from "./db";
import { readWorkspaceAgentCredentialStatus } from "./agent-credentials";
import { syncWorkspaceRuntimeStatus } from "./provisioning";

export async function loadWorkspaceDashboard(
  fetchImpl: typeof fetch = fetch,
  database: Pick<
    typeof db,
    "workspace" | "agentCredential" | "platformAgentCredentialConfig" | "symphonyInstance"
  > = db,
  dependencies: {
    syncWorkspaceRuntimeStatusImpl?: typeof syncWorkspaceRuntimeStatus;
  } = {}
) {
  const syncWorkspaceRuntimeStatusImpl =
    dependencies.syncWorkspaceRuntimeStatusImpl ?? syncWorkspaceRuntimeStatus;
  const workspaces = await database.workspace.findMany({
    include: {
      repositories: true,
      symphonyInstance: true
    },
    orderBy: {
      createdAt: "desc"
    }
  });

  return Promise.all(
    workspaces.map(async (workspace) => {
      const agentCredential = await readWorkspaceAgentCredentialStatus(
        workspace.id,
        database as Parameters<typeof readWorkspaceAgentCredentialStatus>[1]
      );
      const runtime = workspace.symphonyInstance;

      if (!runtime) {
        return {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          status: workspace.status,
          agentCredential,
          runtime: null
        };
      }

      try {
        const status = await syncWorkspaceRuntimeStatusImpl(
          {
            workspaceId: workspace.id,
            runtimeDriver: runtime.runtimeDriver,
            runtimeId: runtime.runtimeId,
            processId: runtime.processId
          },
          {
            db: database as Pick<typeof db, "symphonyInstance">
          }
        );
        const response = await fetchImpl(
          `http://${runtime.endpointHost}:${runtime.port}/api/v1/state`
        );

        if (!response.ok) {
          throw new Error(`State endpoint returned ${response.status}`);
        }

        const payload = (await response.json()) as unknown;

        return {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          status: workspace.status,
          agentCredential,
          runtime: {
            driver: runtime.runtimeDriver,
            health: "healthy",
            status,
            host: runtime.endpointHost,
            port: runtime.port,
            state: payload
          }
        };
      } catch (error: unknown) {
        return {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          status: workspace.status,
          agentCredential,
          runtime: {
            driver: runtime.runtimeDriver,
            health: "degraded",
            status: runtime.status,
            host: runtime.endpointHost,
            port: runtime.port,
            state: {
              error: error instanceof Error ? error.message : "Unknown error"
            }
          }
        };
      }
    })
  );
}

import { db } from "./db";
import { readWorkspaceAgentCredentialStatus } from "./agent-credentials";

export async function loadWorkspaceDashboard(
  fetchImpl: typeof fetch = fetch,
  database: Pick<
    typeof db,
    "workspace" | "agentCredential" | "platformAgentCredentialConfig"
  > = db
) {
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
        const response = await fetchImpl(
          `http://127.0.0.1:${runtime.port}/api/v1/state`
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
            status: runtime.status,
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
            status: "degraded",
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

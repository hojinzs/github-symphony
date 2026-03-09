import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WorkspaceStatusSnapshot } from "@github-symphony/core";

export async function resolveOrchestratorStatusResponse(
  pathname: string,
  getWorkspaceStatus: {
    all: () => Promise<WorkspaceStatusSnapshot[]>;
    byWorkspaceId: (workspaceId: string) => Promise<WorkspaceStatusSnapshot | null>;
  }
): Promise<{
  status: number;
  payload: unknown;
}> {
  if (pathname === "/healthz") {
    return {
      status: 200,
      payload: { ok: true }
    };
  }

  if (pathname === "/api/v1/status") {
    return {
      status: 200,
      payload: await getWorkspaceStatus.all()
    };
  }

  const workspaceMatch = pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/status$/);

  if (workspaceMatch) {
    const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
    const snapshot = await getWorkspaceStatus.byWorkspaceId(workspaceId);

    if (!snapshot) {
      return {
        status: 404,
        payload: {
          error: "Workspace status not found.",
          workspaceId
        }
      };
    }

    return {
      status: 200,
      payload: snapshot
    };
  }

  return {
    status: 404,
    payload: { error: "Not found" }
  };
}

export function createOrchestratorRequestHandler(getWorkspaceStatus: {
  all: () => Promise<WorkspaceStatusSnapshot[]>;
  byWorkspaceId: (workspaceId: string) => Promise<WorkspaceStatusSnapshot | null>;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const resolved = await resolveOrchestratorStatusResponse(url.pathname, getWorkspaceStatus);
    respondJson(response, resolved.status, resolved.payload);
  };
}

export function startOrchestratorStatusServer(options: {
  host: string;
  port: number;
  getWorkspaceStatus: {
    all: () => Promise<WorkspaceStatusSnapshot[]>;
    byWorkspaceId: (workspaceId: string) => Promise<WorkspaceStatusSnapshot | null>;
  };
}): Server {
  const server = createServer((request, response) => {
    void createOrchestratorRequestHandler(options.getWorkspaceStatus)(request, response);
  });

  server.listen(options.port, options.host);
  return server;
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

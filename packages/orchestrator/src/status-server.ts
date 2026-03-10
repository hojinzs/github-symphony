import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { WorkspaceStatusSnapshot } from "@github-symphony/core";

let refreshPending = false;

type WorkspaceStatusReader = {
  all: () => Promise<WorkspaceStatusSnapshot[]>;
  byWorkspaceId: (
    workspaceId: string
  ) => Promise<WorkspaceStatusSnapshot | null>;
};

function isWorkspaceStatusReader(
  value: unknown
): value is WorkspaceStatusReader {
  return Boolean(
    value &&
    typeof value === "object" &&
    "all" in value &&
    typeof value.all === "function" &&
    "byWorkspaceId" in value &&
    typeof value.byWorkspaceId === "function"
  );
}

export async function resolveOrchestratorStatusResponse(
  pathname: string,
  methodOrGetWorkspaceStatus: string | WorkspaceStatusReader,
  getWorkspaceStatusOrOnRefresh?: WorkspaceStatusReader | (() => void),
  onRefresh?: () => void
): Promise<{
  status: number;
  payload: unknown;
}> {
  const method =
    typeof methodOrGetWorkspaceStatus === "string"
      ? methodOrGetWorkspaceStatus
      : "GET";
  const getWorkspaceStatus = isWorkspaceStatusReader(methodOrGetWorkspaceStatus)
    ? methodOrGetWorkspaceStatus
    : isWorkspaceStatusReader(getWorkspaceStatusOrOnRefresh)
      ? getWorkspaceStatusOrOnRefresh
      : null;
  const refreshCallback =
    typeof methodOrGetWorkspaceStatus === "string"
      ? typeof onRefresh === "function"
        ? onRefresh
        : undefined
      : typeof getWorkspaceStatusOrOnRefresh === "function"
        ? getWorkspaceStatusOrOnRefresh
        : typeof onRefresh === "function"
          ? onRefresh
          : undefined;

  if (!getWorkspaceStatus) {
    return {
      status: 500,
      payload: { error: "Workspace status reader not configured." },
    };
  }

  if (pathname === "/healthz") {
    return {
      status: 200,
      payload: { ok: true },
    };
  }

  if (pathname === "/api/v1/status") {
    return {
      status: 200,
      payload: await getWorkspaceStatus.all(),
    };
  }
  if (pathname === "/api/v1/refresh") {
    if (method !== "POST") {
      return {
        status: 405,
        payload: { error: "Method not allowed" },
      };
    }
    if (refreshPending) {
      return {
        status: 202,
        payload: { queued: true, coalesced: true },
      };
    }
    refreshPending = true;
    try {
      refreshCallback?.();
    } finally {
      refreshPending = false;
    }
    return {
      status: 202,
      payload: { queued: true },
    };
  }

  const workspaceMatch = pathname.match(
    /^\/api\/v1\/workspaces\/([^/]+)\/status$/
  );

  if (workspaceMatch) {
    const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
    const snapshot = await getWorkspaceStatus.byWorkspaceId(workspaceId);

    if (!snapshot) {
      return {
        status: 404,
        payload: {
          error: "Workspace status not found.",
          workspaceId,
        },
      };
    }

    return {
      status: 200,
      payload: snapshot,
    };
  }

  return {
    status: 404,
    payload: { error: "Not found" },
  };
}

export function createOrchestratorRequestHandler(
  getWorkspaceStatus: {
    all: () => Promise<WorkspaceStatusSnapshot[]>;
    byWorkspaceId: (
      workspaceId: string
    ) => Promise<WorkspaceStatusSnapshot | null>;
  },
  onRefresh?: () => void
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const resolved = await resolveOrchestratorStatusResponse(
      url.pathname,
      request.method ?? "GET",
      getWorkspaceStatus,
      onRefresh
    );
    respondJson(response, resolved.status, resolved.payload);
  };
}

export function startOrchestratorStatusServer(options: {
  host: string;
  port: number;
  getWorkspaceStatus: {
    all: () => Promise<WorkspaceStatusSnapshot[]>;
    byWorkspaceId: (
      workspaceId: string
    ) => Promise<WorkspaceStatusSnapshot | null>;
  };
  onRefresh?: () => void;
}): Server {
  const server = createServer((request, response) => {
    void createOrchestratorRequestHandler(
      options.getWorkspaceStatus,
      options.onRefresh
    )(request, response);
  });

  server.listen(options.port, options.host);
  return server;
}

function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

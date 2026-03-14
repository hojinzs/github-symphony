import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";

let refreshInFlight: Promise<void> | null = null;

type ProjectStatusReader = {
  all: () => Promise<ProjectStatusSnapshot[]>;
  byProjectId: (
    projectId: string
  ) => Promise<ProjectStatusSnapshot | null>;
};

function isProjectStatusReader(
  value: unknown
): value is ProjectStatusReader {
  return Boolean(
    value &&
    typeof value === "object" &&
    "all" in value &&
    typeof value.all === "function" &&
    "byProjectId" in value &&
    typeof value.byProjectId === "function"
  );
}

export async function resolveOrchestratorStatusResponse(
  pathname: string,
  methodOrGetProjectStatus: string | ProjectStatusReader,
  getProjectStatusOrOnRefresh?: ProjectStatusReader | (() => void | Promise<void>),
  onRefresh?: () => void | Promise<void>
): Promise<{
  status: number;
  payload: unknown;
}> {
  const method =
    typeof methodOrGetProjectStatus === "string"
      ? methodOrGetProjectStatus
      : "GET";
  const getProjectStatus = isProjectStatusReader(methodOrGetProjectStatus)
    ? methodOrGetProjectStatus
    : isProjectStatusReader(getProjectStatusOrOnRefresh)
      ? getProjectStatusOrOnRefresh
      : null;
  const refreshCallback =
    typeof methodOrGetProjectStatus === "string"
      ? typeof onRefresh === "function"
        ? onRefresh
        : undefined
      : typeof getProjectStatusOrOnRefresh === "function"
        ? getProjectStatusOrOnRefresh
        : typeof onRefresh === "function"
          ? onRefresh
          : undefined;

  if (!getProjectStatus) {
    return {
      status: 500,
      payload: { error: "Project status reader not configured." },
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
      payload: await getProjectStatus.all(),
    };
  }
  if (pathname === "/api/v1/refresh") {
    if (method !== "POST") {
      return {
        status: 405,
        payload: { error: "Method not allowed" },
      };
    }
    if (refreshInFlight) {
      return {
        status: 202,
        payload: { queued: true, coalesced: true },
      };
    }

    refreshInFlight = Promise.resolve(refreshCallback?.());
    try {
      await refreshInFlight;
    } catch (error) {
      return {
        status: 500,
        payload: {
          error:
            error instanceof Error
              ? error.message
              : "Failed to refresh orchestrator status.",
        },
      };
    } finally {
      refreshInFlight = null;
    }
    return {
      status: 202,
      payload: { queued: true },
    };
  }

  const projectMatch = pathname.match(
    /^\/api\/v1\/projects\/([^/]+)\/status$/
  );

  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1] ?? "");
    const snapshot = await getProjectStatus.byProjectId(projectId);

    if (!snapshot) {
      return {
        status: 404,
        payload: {
          error: "Project status not found.",
          projectId,
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
  getProjectStatus: {
    all: () => Promise<ProjectStatusSnapshot[]>;
    byProjectId: (
      projectId: string
    ) => Promise<ProjectStatusSnapshot | null>;
  },
  onRefresh?: () => void | Promise<void>
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const resolved = await resolveOrchestratorStatusResponse(
      url.pathname,
      request.method ?? "GET",
      getProjectStatus,
      onRefresh
    );
    respondJson(response, resolved.status, resolved.payload);
  };
}

export function startOrchestratorStatusServer(options: {
  host: string;
  port: number;
  getProjectStatus: {
    all: () => Promise<ProjectStatusSnapshot[]>;
    byProjectId: (
      projectId: string
    ) => Promise<ProjectStatusSnapshot | null>;
  };
  onRefresh?: () => void | Promise<void>;
}): Server {
  const server = createServer((request, response) => {
    void createOrchestratorRequestHandler(
      options.getProjectStatus,
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

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  IssueStatusSnapshot,
  ProjectStatusSnapshot,
} from "@gh-symphony/core";

let refreshInFlight: Promise<void> | null = null;

type ProjectStatusReader = () => Promise<ProjectStatusSnapshot | null>;
type IssueStatusReader = (
  issueIdentifier: string
) => Promise<IssueStatusSnapshot | null>;

export async function resolveOrchestratorStatusResponse(options: {
  pathname: string;
  method?: string;
  getProjectStatus: ProjectStatusReader;
  getIssueStatus?: IssueStatusReader;
  onRefresh?: () => void | Promise<void>;
}): Promise<{
  status: number;
  payload: unknown;
}> {
  const method = options.method ?? "GET";

  if (options.pathname === "/healthz") {
    return {
      status: 200,
      payload: { ok: true },
    };
  }

  if (options.pathname === "/api/v1/status") {
    if (method !== "GET") {
      return {
        status: 405,
        payload: { error: "Method not allowed" },
      };
    }

    const snapshot = await options.getProjectStatus();
    if (!snapshot) {
      return {
        status: 404,
        payload: { error: "Project status not found." },
      };
    }

    return {
      status: 200,
      payload: snapshot,
    };
  }

  if (options.pathname === "/api/v1/refresh") {
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

    refreshInFlight = Promise.resolve(options.onRefresh?.()).then(
      () => undefined
    );
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

  if (options.pathname.startsWith("/api/v1/")) {
    if (method !== "GET") {
      return {
        status: 405,
        payload: { error: "Method not allowed" },
      };
    }

    const rawIdentifier = options.pathname.slice("/api/v1/".length);
    if (!rawIdentifier) {
      return {
        status: 404,
        payload: { error: "Not found" },
      };
    }

    if (!options.getIssueStatus) {
      return {
        status: 501,
        payload: {
          error: {
            code: "issue_status_not_supported",
            message: "Issue status lookup is not configured.",
          },
        },
      };
    }

    let issueIdentifier: string;
    try {
      issueIdentifier = decodeURIComponent(rawIdentifier);
    } catch {
      return {
        status: 400,
        payload: {
          error: {
            code: "invalid_issue_identifier",
            message: "Issue identifier path segment is not valid URL encoding.",
          },
        },
      };
    }
    const issueStatus = await options.getIssueStatus(issueIdentifier);
    if (!issueStatus) {
      return {
        status: 404,
        payload: {
          error: {
            code: "issue_not_found",
            message: `Issue "${issueIdentifier}" is unknown to the current in-memory state.`,
          },
        },
      };
    }

    return {
      status: 200,
      payload: issueStatus,
    };
  }

  return {
    status: 404,
    payload: { error: "Not found" },
  };
}

export function createOrchestratorRequestHandler(
  getProjectStatus: ProjectStatusReader,
  getIssueStatus?: IssueStatusReader,
  onRefresh?: () => void | Promise<void>
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const resolved = await resolveOrchestratorStatusResponse({
      pathname: url.pathname,
      method: request.method ?? "GET",
      getProjectStatus,
      getIssueStatus,
      onRefresh,
    });
    respondJson(response, resolved.status, resolved.payload);
  };
}

export function startOrchestratorStatusServer(options: {
  host: string;
  port: number;
  getProjectStatus: ProjectStatusReader;
  getIssueStatus?: IssueStatusReader;
  onRefresh?: () => void | Promise<void>;
}): Server {
  const server = createServer((request, response) => {
    void createOrchestratorRequestHandler(
      options.getProjectStatus,
      options.getIssueStatus,
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

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { DashboardFsReader, statusForIssue } from "./store.js";

export async function resolveDashboardResponse(options: {
  pathname: string;
  method?: string;
  reader: DashboardFsReader;
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

  if (options.pathname === "/api/v1/state") {
    if (method !== "GET") {
      return {
        status: 405,
        payload: { error: "Method not allowed" },
      };
    }

    const snapshot = await options.reader.loadProjectStatus();
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

  if (options.pathname.startsWith("/api/v1/")) {
    if (method !== "GET") {
      return {
        status: 405,
        payload: { error: "Method not allowed" },
      };
    }

    const rawIdentifier = options.pathname.slice("/api/v1/".length);
    if (!rawIdentifier || rawIdentifier === "state") {
      return {
        status: 404,
        payload: { error: "Not found" },
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

    const issueStatus = await statusForIssue(options.reader, issueIdentifier);
    if (!issueStatus) {
      return {
        status: 404,
        payload: {
          error: {
            code: "issue_not_found",
            message: `Issue "${issueIdentifier}" is unknown to the current filesystem state.`,
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

export function createDashboardRequestHandler(
  reader: DashboardFsReader
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const resolved = await resolveDashboardResponse({
      pathname: url.pathname,
      method: request.method ?? "GET",
      reader,
    });
    respondJson(response, resolved.status, resolved.payload);
  };
}

export function startDashboardServer(options: {
  host: string;
  port: number;
  reader: DashboardFsReader;
}): Server {
  const server = createServer((request, response) => {
    void createDashboardRequestHandler(options.reader)(request, response);
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

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { DashboardFsReader, statusForIssue } from "./store.js";

const REDACTED = "[REDACTED]";
const STATE_REDACTED_KEYS = new Set([
  "currentRunId",
  "identifier",
  "issueId",
  "issueIdentifier",
  "lastError",
  "runId",
  "sessionId",
  "tokenUsage",
  "workingDirectory",
  "workspaceKey",
  "workspacePath",
  "workspaceRuntimeDir",
]);

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

    const snapshot = await options.reader.loadProjectState();
    if (!snapshot) {
      return {
        status: 404,
        payload: { error: "Project status not found." },
      };
    }

    return {
      status: 200,
      payload: redactDashboardState(snapshot),
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

export function createDashboardRequestHandler(options: {
  reader: DashboardFsReader;
  apiToken: string;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  assertApiToken(options.apiToken);

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        url.pathname.startsWith("/api/v1/") &&
        !isAuthorizedApiRequest(request, options.apiToken)
      ) {
        respondJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const resolved = await resolveDashboardResponse({
        pathname: url.pathname,
        method: request.method ?? "GET",
        reader: options.reader,
      });
      respondJson(response, resolved.status, resolved.payload);
    } catch (error) {
      console.error("Dashboard request failed.", error);
      if (!response.headersSent) {
        respondJson(response, 500, {
          error: "Internal server error",
        });
      } else {
        response.end();
      }
    }
  };
}

export function startDashboardServer(options: {
  host?: string;
  port: number;
  reader: DashboardFsReader;
  apiToken: string;
}): Server {
  const handler = createDashboardRequestHandler({
    reader: options.reader,
    apiToken: options.apiToken,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });

  server.listen(options.port, options.host ?? "127.0.0.1");
  return server;
}

export function isAuthorizedApiRequest(
  request: Pick<IncomingMessage, "headers">,
  apiToken: string
): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return false;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1]) {
    return false;
  }

  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(apiToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertApiToken(apiToken: string): void {
  if (!apiToken.trim()) {
    throw new Error("Dashboard API token must not be empty.");
  }
}

function redactDashboardState(value: unknown, key?: string): unknown {
  if (key && STATE_REDACTED_KEYS.has(key)) {
    return value === null || value === undefined ? value : REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDashboardState(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactDashboardState(entryValue, entryKey),
    ])
  );
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

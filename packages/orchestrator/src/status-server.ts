import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { TenantStatusSnapshot } from "@gh-symphony/core";

let refreshInFlight: Promise<void> | null = null;

type TenantStatusReader = {
  all: () => Promise<TenantStatusSnapshot[]>;
  byTenantId: (
    tenantId: string
  ) => Promise<TenantStatusSnapshot | null>;
};

function isTenantStatusReader(
  value: unknown
): value is TenantStatusReader {
  return Boolean(
    value &&
    typeof value === "object" &&
    "all" in value &&
    typeof value.all === "function" &&
    "byTenantId" in value &&
    typeof value.byTenantId === "function"
  );
}

export async function resolveOrchestratorStatusResponse(
  pathname: string,
  methodOrGetTenantStatus: string | TenantStatusReader,
  getTenantStatusOrOnRefresh?: TenantStatusReader | (() => void | Promise<void>),
  onRefresh?: () => void | Promise<void>
): Promise<{
  status: number;
  payload: unknown;
}> {
  const method =
    typeof methodOrGetTenantStatus === "string"
      ? methodOrGetTenantStatus
      : "GET";
  const getTenantStatus = isTenantStatusReader(methodOrGetTenantStatus)
    ? methodOrGetTenantStatus
    : isTenantStatusReader(getTenantStatusOrOnRefresh)
      ? getTenantStatusOrOnRefresh
      : null;
  const refreshCallback =
    typeof methodOrGetTenantStatus === "string"
      ? typeof onRefresh === "function"
        ? onRefresh
        : undefined
      : typeof getTenantStatusOrOnRefresh === "function"
        ? getTenantStatusOrOnRefresh
        : typeof onRefresh === "function"
          ? onRefresh
          : undefined;

  if (!getTenantStatus) {
    return {
      status: 500,
      payload: { error: "Tenant status reader not configured." },
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
      payload: await getTenantStatus.all(),
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

  const tenantMatch = pathname.match(
    /^\/api\/v1\/tenants\/([^/]+)\/status$/
  );

  if (tenantMatch) {
    const tenantId = decodeURIComponent(tenantMatch[1] ?? "");
    const snapshot = await getTenantStatus.byTenantId(tenantId);

    if (!snapshot) {
      return {
        status: 404,
        payload: {
          error: "Tenant status not found.",
          tenantId,
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
  getTenantStatus: {
    all: () => Promise<TenantStatusSnapshot[]>;
    byTenantId: (
      tenantId: string
    ) => Promise<TenantStatusSnapshot | null>;
  },
  onRefresh?: () => void | Promise<void>
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const resolved = await resolveOrchestratorStatusResponse(
      url.pathname,
      request.method ?? "GET",
      getTenantStatus,
      onRefresh
    );
    respondJson(response, resolved.status, resolved.payload);
  };
}

export function startOrchestratorStatusServer(options: {
  host: string;
  port: number;
  getTenantStatus: {
    all: () => Promise<TenantStatusSnapshot[]>;
    byTenantId: (
      tenantId: string
    ) => Promise<TenantStatusSnapshot | null>;
  };
  onRefresh?: () => void | Promise<void>;
}): Server {
  const server = createServer((request, response) => {
    void createOrchestratorRequestHandler(
      options.getTenantStatus,
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

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DashboardFsReader,
  resolveDashboardResponse,
} from "@gh-symphony/dashboard";

const CLIENT_DIST_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../client/dist"
);

const TEXT_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/plain",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

export interface ControlPlaneServerOptions {
  host: string;
  port: number;
  runtimeRoot: string;
  projectId: string;
  onRefreshRequest?: () => void;
}

export interface ControlPlaneHandlerOptions {
  reader: DashboardFsReader;
  onRefreshRequest?: () => void;
}

export interface ControlPlaneServerStartResult {
  server: Server;
  url: string;
  port: number;
}

export function createControlPlaneHandler(options: ControlPlaneHandlerOptions): (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<void> {
  return async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/api/v1/refresh") {
        await handleRefreshRequest(method, request, response, options);
        return;
      }

      if (isDashboardRequest(url.pathname)) {
        const resolved = await resolveDashboardResponse({
          pathname: url.pathname,
          method,
          reader: options.reader,
        });
        respondJson(response, resolved.status, resolved.payload);
        return;
      }

      if (!isStaticRequestMethod(method)) {
        respondJson(response, 405, { error: "Method not allowed" });
        return;
      }

      const asset = await resolveStaticAsset(url.pathname);
      if (!asset) {
        respondJson(response, 404, { error: "Not found" });
        return;
      }

      if (asset.kind === "error") {
        respondJson(response, asset.status, { error: "Bad request" });
        return;
      }

      await respondFile(response, asset.path, method, asset.fallback);
    } catch (error) {
      console.error("Control plane request failed.", error);
      if (!response.headersSent) {
        respondJson(response, 500, { error: "Internal server error" });
      } else {
        response.end();
      }
    }
  };
}

export async function startControlPlaneServer(
  options: ControlPlaneServerOptions
): Promise<ControlPlaneServerStartResult> {
  const reader = new DashboardFsReader(options.runtimeRoot, options.projectId);
  const handler = createControlPlaneHandler({
    reader,
    onRefreshRequest: options.onRefreshRequest,
  });

  for (let port = options.port; port <= 65_535; port += 1) {
    const server = createServer((request, response) => {
      void handler(request, response);
    });

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const cleanup = () => {
          server.off("listening", handleListening);
          server.off("error", handleError);
        };
        const handleListening = () => {
          cleanup();
          resolveReady();
        };
        const handleError = (error: NodeJS.ErrnoException) => {
          cleanup();
          rejectReady(error);
        };

        server.once("listening", handleListening);
        server.once("error", handleError);
        server.listen(port, options.host);
      });

      const address = server.address();
      const boundPort =
        address && typeof address !== "string" ? address.port : port;

      return {
        server,
        port: boundPort,
        url: formatBoundUrl(server),
      };
    } catch (error) {
      await closeServer(server).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Unable to bind control plane server starting from port ${options.port}`
  );
}

async function handleRefreshRequest(
  method: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneHandlerOptions
): Promise<void> {
  if (method !== "POST") {
    respondJson(response, 405, { error: "Method not allowed" });
    return;
  }

  request.resume();
  options.onRefreshRequest?.();
  respondJson(response, 202, { ok: true });
}

function isDashboardRequest(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/api/v1/state" ||
    pathname.startsWith("/api/v1/")
  );
}

function isStaticRequestMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

async function resolveStaticAsset(
  pathname: string
): Promise<
  | { kind: "asset"; path: string; fallback: boolean }
  | { kind: "error"; status: 400 }
  | null
> {
  const indexPath = join(CLIENT_DIST_DIR, "index.html");
  if (pathname === "/") {
    return (await existsAsFile(indexPath))
      ? { kind: "asset", path: indexPath, fallback: true }
      : null;
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { kind: "error", status: 400 };
  }

  const resolvedPath = resolve(CLIENT_DIST_DIR, `.${decodedPathname}`);
  if (!isPathInsideClientDist(resolvedPath)) {
    return null;
  }

  if (await existsAsFile(resolvedPath)) {
    return { kind: "asset", path: resolvedPath, fallback: false };
  }

  if (hasFileExtension(decodedPathname)) {
    return null;
  }

  return (await existsAsFile(indexPath))
    ? { kind: "asset", path: indexPath, fallback: true }
    : null;
}

function isPathInsideClientDist(path: string): boolean {
  return path === CLIENT_DIST_DIR || path.startsWith(`${CLIENT_DIST_DIR}${sep}`);
}

function hasFileExtension(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? "";
  return lastSegment.includes(".");
}

async function existsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function respondFile(
  response: ServerResponse,
  path: string,
  method: string,
  fallback: boolean
): Promise<void> {
  const contentType = contentTypeForPath(path);
  const body = method === "HEAD" ? undefined : await readFile(path);
  const cacheControl =
    fallback || path.endsWith(`${sep}index.html`)
      ? "no-cache"
      : "public, max-age=31536000, immutable";
  response.writeHead(200, {
    "cache-control": cacheControl,
    "content-type": contentType,
  });
  response.end(body);
}

function contentTypeForPath(path: string): string {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()];
  if (!contentType) {
    return "application/octet-stream";
  }

  if (TEXT_CONTENT_TYPES.has(contentType)) {
    return `${contentType}; charset=utf-8`;
  }

  return contentType;
}

function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function formatBoundUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    return "http://localhost";
  }

  const host =
    address.address === "::" ||
    address.address === "::1" ||
    address.address === "0.0.0.0" ||
    address.address === "127.0.0.1"
      ? "localhost"
      : address.address;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

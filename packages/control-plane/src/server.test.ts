import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createControlPlaneHandler,
  startControlPlaneServer,
} from "./server.js";

const CLIENT_DIST_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../client/dist"
);
const API_TOKEN = "test-control-plane-token";
const AUTHORIZATION = { authorization: `Bearer ${API_TOKEN}` };

function createReader() {
  return {
    loadProjectState: vi.fn().mockResolvedValue(null),
    loadProjectIssueOrchestrations: vi.fn().mockResolvedValue([]),
    loadRun: vi.fn(),
    loadAllRuns: vi.fn(),
    loadRunsForIssue: vi.fn(),
    loadRecentRunEvents: vi.fn(),
    runtimeRoot: "/tmp/runtime",
    projectDir: vi.fn(),
    runDir: vi.fn(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(CLIENT_DIST_DIR, { recursive: true, force: true });
});

describe("createControlPlaneHandler", () => {
  it("fails fast when the API token is empty", () => {
    expect(() =>
      createControlPlaneHandler({
        reader: createReader() as never,
        apiToken: "   ",
      })
    ).toThrow("Control plane API token must not be empty.");
  });

  it("calls the refresh callback for POST /api/v1/refresh", async () => {
    const onRefreshRequest = vi.fn();
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
      onRefreshRequest,
    });

    const response = await fetchWithHandler(handler, "/api/v1/refresh", {
      method: "POST",
      body: JSON.stringify({ manual: true }),
      headers: AUTHORIZATION,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(onRefreshRequest).toHaveBeenCalledOnce();
  });

  it("rejects refresh bodies over the configured limit", async () => {
    const onRefreshRequest = vi.fn();
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
      onRefreshRequest,
    });

    const response = await fetchWithHandler(handler, "/api/v1/refresh", {
      method: "POST",
      body: Buffer.alloc(64 * 1024 + 1),
      headers: AUTHORIZATION,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body too large",
    });
    expect(onRefreshRequest).not.toHaveBeenCalled();
  });

  it("finishes handling a streaming request as soon as its body is oversized", async () => {
    const http = await import("node:http");
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
    });
    let resolveHandled: (() => void) | undefined;
    const handled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    const instance = http.createServer((request, response) => {
      void handler(request, response).then(() => resolveHandled?.());
    });

    await new Promise<void>((resolve, reject) => {
      instance.listen(0, "127.0.0.1", (error?: Error) =>
        error ? reject(error) : resolve()
      );
    });
    const address = instance.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address");
    }

    const request = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/v1/refresh",
      method: "POST",
      headers: {
        ...AUTHORIZATION,
        "Transfer-Encoding": "chunked",
      },
    });
    try {
      const response = new Promise<{
        statusCode: number | undefined;
        body: string;
      }>((resolve, reject) => {
        request.on("response", (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              statusCode: incoming.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          );
        });
        request.on("error", reject);
      });

      request.write(Buffer.alloc(64 * 1024 + 1));

      await expect(response).resolves.toEqual({
        statusCode: 413,
        body: JSON.stringify({ error: "Request body too large" }),
      });
      await expect(handled).resolves.toBeUndefined();
    } finally {
      request.destroy();
      await new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("delegates GET /api/v1/state to the dashboard resolver", async () => {
    const reader = createReader();
    reader.loadProjectState.mockResolvedValue({
      repository: {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-1",
        settings: {
          projectId: "PVT_project_1",
        },
      },
      lastTickAt: "2026-04-09T00:00:00.000Z",
      health: "idle",
      summary: {
        dispatched: 0,
        suppressed: 0,
        recovered: 0,
        activeRuns: 0,
      },
      activeRuns: [],
      retryQueue: [],
      rateLimits: null,
      lastError: null,
      completedCount: 0,
      issues: [],
    });
    const handler = createControlPlaneHandler({
      reader: reader as never,
      apiToken: API_TOKEN,
    });

    const response = await fetchWithHandler(handler, "/api/v1/state", {
      headers: AUTHORIZATION,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repository: { owner: "acme", name: "platform" },
      tracker: { settings: { projectId: "PVT_project_1" } },
      health: "idle",
    });
  });

  it("rejects unauthenticated API requests before invoking handlers", async () => {
    const reader = createReader();
    const onRefreshRequest = vi.fn();
    const handler = createControlPlaneHandler({
      reader: reader as never,
      apiToken: API_TOKEN,
      onRefreshRequest,
    });

    const stateResponse = await fetchWithHandler(handler, "/api/v1/state");
    expect(stateResponse.status).toBe(401);
    expect(reader.loadProjectState).not.toHaveBeenCalled();

    const refreshResponse = await fetchWithHandler(handler, "/api/v1/refresh", {
      method: "POST",
    });
    expect(refreshResponse.status).toBe(401);
    expect(onRefreshRequest).not.toHaveBeenCalled();
  });

  it("serves static assets from client/dist", async () => {
    await mkdir(join(CLIENT_DIST_DIR, "assets"), { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "assets", "app.js"),
      "console.log(1);"
    );
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
    });

    const response = await fetchWithHandler(handler, "/assets/app.js");

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
    expect(response.headers.get("content-type")).toContain(
      "application/javascript"
    );
    await expect(response.text()).resolves.toBe("console.log(1);");
  });

  it("returns 404 for missing assets with percent-encoded extensions", async () => {
    await mkdir(CLIENT_DIST_DIR, { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "index.html"),
      '<!doctype html><div id="root"></div>'
    );
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
    });

    const response = await fetchWithHandler(handler, "/assets/app%2Ejs");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 400 for malformed percent-encoded paths", async () => {
    await mkdir(CLIENT_DIST_DIR, { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "index.html"),
      '<!doctype html><div id="root"></div>'
    );
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
    });

    const response = await fetchWithHandler(handler, "/%E0%A4%A");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Bad request" });
  });

  it("falls back to client/dist/index.html for SPA routes", async () => {
    await mkdir(CLIENT_DIST_DIR, { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "index.html"),
      '<!doctype html><div id="root"></div>'
    );
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
    });

    const response = await fetchWithHandler(
      handler,
      "/issues/acme%2Frepo%23123"
    );

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain('<div id="root"></div>');
  });

  it("serves index.html with no-cache even when requested directly", async () => {
    await mkdir(CLIENT_DIST_DIR, { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "index.html"),
      '<!doctype html><div id="root"></div>'
    );
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      apiToken: API_TOKEN,
    });

    const response = await fetchWithHandler(handler, "/index.html");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("logs a sanitized error type without message, stack, or path", async () => {
    const reader = createReader();
    const sensitiveError = new Error(
      "token=super-secret at /Users/operator/private/workspace"
    );
    reader.loadProjectState.mockRejectedValue(sensitiveError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createControlPlaneHandler({
      reader: reader as never,
      apiToken: API_TOKEN,
    });

    const response = await fetchWithHandler(handler, "/api/v1/state", {
      headers: AUTHORIZATION,
    });

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith("Control plane request failed.", {
      errorType: "Error",
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("super-secret");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("/Users/");
  });
});

describe("startControlPlaneServer", () => {
  it("starts an HTTP server that exposes /healthz", async () => {
    await mkdir(CLIENT_DIST_DIR, { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "index.html"),
      '<!doctype html><div id="root"></div>'
    );
    const runtimeRoot = await mkdtemp(join(tmpdir(), "control-plane-runtime-"));
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(
      join(runtimeRoot, "status.json"),
      JSON.stringify({
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-1",
          settings: { projectId: "PVT_project_1" },
        },
        lastTickAt: "2026-04-09T00:00:00.000Z",
        health: "idle",
        summary: {
          dispatched: 0,
          suppressed: 0,
          recovered: 0,
          activeRuns: 0,
        },
        activeRuns: [],
        retryQueue: [],
        rateLimits: null,
        lastError: null,
      })
    );
    await writeFile(join(runtimeRoot, "issues.json"), "[]");

    const started = await startControlPlaneServer({
      port: 0,
      runtimeRoot,
      apiToken: API_TOKEN,
    });

    try {
      const response = await fetch(`${started.url}/healthz`);

      expect(started.port).toBeGreaterThan(0);
      expect(started.server.address()).toMatchObject({
        address: "127.0.0.1",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

async function fetchWithHandler(
  handler: ReturnType<typeof createControlPlaneHandler>,
  pathname: string,
  init?: RequestInit
): Promise<Response> {
  const server = await startEphemeralServer(handler);
  try {
    return await fetch(`${server.url}${pathname}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.instance.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'"
  );
  expect(response.headers.get("permissions-policy")).toBe(
    "camera=(), geolocation=(), microphone=()"
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

async function startEphemeralServer(
  handler: ReturnType<typeof createControlPlaneHandler>
): Promise<{
  instance: Awaited<ReturnType<typeof import("node:http").createServer>>;
  url: string;
}> {
  const http = await import("node:http");
  const instance = http.createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    instance.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = instance.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }

  return {
    instance,
    url: `http://127.0.0.1:${address.port}`,
  };
}

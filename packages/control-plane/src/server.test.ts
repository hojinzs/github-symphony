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

function createReader() {
  return {
    loadProjectState: vi.fn().mockResolvedValue(null),
    loadProjectIssueOrchestrations: vi.fn().mockResolvedValue([]),
    loadRun: vi.fn(),
    loadAllRuns: vi.fn(),
    loadRunsForIssue: vi.fn(),
    loadRecentRunEvents: vi.fn(),
    projectId: "tenant-1",
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
  it("calls the refresh callback for POST /api/v1/refresh", async () => {
    const onRefreshRequest = vi.fn();
    const handler = createControlPlaneHandler({
      reader: createReader() as never,
      onRefreshRequest,
    });

    const response = await fetchWithHandler(handler, "/api/v1/refresh", {
      method: "POST",
      body: JSON.stringify({ manual: true }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(onRefreshRequest).toHaveBeenCalledOnce();
  });

  it("delegates GET /api/v1/state to the dashboard resolver", async () => {
    const reader = createReader();
    reader.loadProjectState.mockResolvedValue({
      projectId: "tenant-1",
      slug: "tenant-1",
      tracker: {
        adapter: "github-project",
        bindingId: "project-1",
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
    const handler = createControlPlaneHandler({ reader: reader as never });

    const response = await fetchWithHandler(handler, "/api/v1/state");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectId: "tenant-1",
      health: "idle",
    });
  });

  it("serves static assets from client/dist", async () => {
    await mkdir(join(CLIENT_DIST_DIR, "assets"), { recursive: true });
    await writeFile(join(CLIENT_DIST_DIR, "assets", "app.js"), "console.log(1);");
    const handler = createControlPlaneHandler({ reader: createReader() as never });

    const response = await fetchWithHandler(handler, "/assets/app.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/javascript"
    );
    await expect(response.text()).resolves.toBe("console.log(1);");
  });

  it("falls back to client/dist/index.html for SPA routes", async () => {
    await mkdir(CLIENT_DIST_DIR, { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "index.html"),
      "<!doctype html><div id=\"root\"></div>"
    );
    const handler = createControlPlaneHandler({ reader: createReader() as never });

    const response = await fetchWithHandler(handler, "/issues/acme%2Frepo%23123");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("<div id=\"root\"></div>");
  });
});

describe("startControlPlaneServer", () => {
  it("starts an HTTP server that exposes /healthz", async () => {
    await mkdir(CLIENT_DIST_DIR, { recursive: true });
    await writeFile(
      join(CLIENT_DIST_DIR, "index.html"),
      "<!doctype html><div id=\"root\"></div>"
    );
    const runtimeRoot = await mkdtemp(join(tmpdir(), "control-plane-runtime-"));
    await mkdir(join(runtimeRoot, "projects", "tenant-1"), { recursive: true });
    await writeFile(
      join(runtimeRoot, "projects", "tenant-1", "status.json"),
      JSON.stringify({
        projectId: "tenant-1",
        slug: "tenant-1",
        tracker: { adapter: "github-project", bindingId: "project-1" },
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
    await writeFile(
      join(runtimeRoot, "projects", "tenant-1", "issues.json"),
      "[]"
    );

    const started = await startControlPlaneServer({
      host: "127.0.0.1",
      port: 0,
      runtimeRoot,
      projectId: "tenant-1",
    });

    try {
      const response = await fetch(`${started.url}/healthz`);

      expect(started.port).toBeGreaterThan(0);
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

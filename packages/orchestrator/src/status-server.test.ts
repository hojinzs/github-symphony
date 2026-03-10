import { describe, expect, it, vi } from "vitest";
import { resolveOrchestratorStatusResponse } from "./status-server.js";

describe("POST /api/v1/refresh", () => {
  it("triggers onRefresh callback on POST", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byWorkspaceId: vi.fn().mockResolvedValue(null),
    };
    const onRefresh = vi.fn();

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "POST",
      mockStatus,
      onRefresh
    );

    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ queued: true });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("returns 405 for GET on /api/v1/refresh", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byWorkspaceId: vi.fn().mockResolvedValue(null),
    };

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "GET",
      mockStatus
    );

    expect(result.status).toBe(405);
    expect(result.payload).toEqual({ error: "Method not allowed" });
  });

  it("returns 405 for PUT on /api/v1/refresh", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byWorkspaceId: vi.fn().mockResolvedValue(null),
    };

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "PUT",
      mockStatus
    );

    expect(result.status).toBe(405);
    expect(result.payload).toEqual({ error: "Method not allowed" });
  });

  it("works when onRefresh is not provided", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byWorkspaceId: vi.fn().mockResolvedValue(null),
    };

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "POST",
      mockStatus
    );

    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ queued: true });
  });

  it("keeps the legacy GET signature working for workspace status lookups", async () => {
    const snapshot = {
      workspaceId: "workspace-1",
      slug: "workspace-1",
      tracker: {
        adapter: "github-project",
        bindingId: "project-1",
      },
      lastTickAt: new Date().toISOString(),
      health: "idle",
      summary: {
        dispatched: 0,
        suppressed: 0,
        recovered: 0,
        activeRuns: 0,
      },
      activeRuns: [],
      retryQueue: [],
      lastError: null,
    } as const;
    const mockStatus = {
      all: vi.fn().mockResolvedValue([snapshot]),
      byWorkspaceId: vi.fn().mockResolvedValue(snapshot),
    };

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/workspaces/workspace-1/status",
      mockStatus
    );

    expect(result.status).toBe(200);
    expect(result.payload).toEqual(snapshot);
    expect(mockStatus.byWorkspaceId).toHaveBeenCalledWith("workspace-1");
  });
});

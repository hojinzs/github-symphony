import { describe, expect, it, vi } from "vitest";
import { resolveOrchestratorStatusResponse } from "./status-server.js";

describe("POST /api/v1/refresh", () => {
  it("triggers onRefresh callback on POST", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byProjectId: vi.fn().mockResolvedValue(null),
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
      byProjectId: vi.fn().mockResolvedValue(null),
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
      byProjectId: vi.fn().mockResolvedValue(null),
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
      byProjectId: vi.fn().mockResolvedValue(null),
    };

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "POST",
      mockStatus
    );

    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ queued: true });
  });

  it("awaits async refresh completion before returning", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byProjectId: vi.fn().mockResolvedValue(null),
    };
    let released = false;
    const onRefresh = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            released = true;
            resolve();
          }, 0);
        })
    );

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "POST",
      mockStatus,
      onRefresh
    );

    expect(released).toBe(true);
    expect(result.status).toBe(202);
  });

  it("coalesces concurrent refresh requests while one is running", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byProjectId: vi.fn().mockResolvedValue(null),
    };
    let resolveRefresh: (() => void) | null = null;
    const onRefresh = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const first = resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "POST",
      mockStatus,
      onRefresh
    );
    const second = await resolveOrchestratorStatusResponse(
      "/api/v1/refresh",
      "POST",
      mockStatus,
      onRefresh
    );

    expect(second).toEqual({
      status: 202,
      payload: { queued: true, coalesced: true },
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await expect(first).resolves.toEqual({
      status: 202,
      payload: { queued: true },
    });
  });

  it("returns 500 when refresh callback rejects and clears the in-flight state", async () => {
    const mockStatus = {
      all: vi.fn().mockResolvedValue([]),
      byProjectId: vi.fn().mockResolvedValue(null),
    };
    const onRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce(undefined);

    await expect(
      resolveOrchestratorStatusResponse(
        "/api/v1/refresh",
        "POST",
        mockStatus,
        onRefresh
      )
    ).resolves.toEqual({
      status: 500,
      payload: { error: "refresh failed" },
    });

    await expect(
      resolveOrchestratorStatusResponse(
        "/api/v1/refresh",
        "POST",
        mockStatus,
        onRefresh
      )
    ).resolves.toEqual({
      status: 202,
      payload: { queued: true },
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the legacy GET signature working for project status lookups", async () => {
    const snapshot = {
      projectId: "tenant-1",
      slug: "tenant-1",
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
      byProjectId: vi.fn().mockResolvedValue(snapshot),
    };

    const result = await resolveOrchestratorStatusResponse(
      "/api/v1/projects/tenant-1/status",
      mockStatus
    );

    expect(result.status).toBe(200);
    expect(result.payload).toEqual(snapshot);
    expect(mockStatus.byProjectId).toHaveBeenCalledWith("tenant-1");
  });
});

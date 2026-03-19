import { describe, expect, it, vi } from "vitest";
import { resolveOrchestratorStatusResponse } from "./status-server.js";

function createOptions(overrides: Partial<Parameters<
  typeof resolveOrchestratorStatusResponse
>[0]> = {}): Parameters<typeof resolveOrchestratorStatusResponse>[0] {
  return {
    pathname: "/api/v1/status",
    method: "GET",
    getProjectStatus: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("POST /api/v1/refresh", () => {
  it("triggers onRefresh callback on POST", async () => {
    const onRefresh = vi.fn();

    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/refresh",
        method: "POST",
        onRefresh,
      })
    );

    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ queued: true });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("returns 405 for GET on /api/v1/refresh", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/refresh",
        method: "GET",
      })
    );

    expect(result.status).toBe(405);
    expect(result.payload).toEqual({ error: "Method not allowed" });
  });

  it("returns 405 for PUT on /api/v1/refresh", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/refresh",
        method: "PUT",
      })
    );

    expect(result.status).toBe(405);
    expect(result.payload).toEqual({ error: "Method not allowed" });
  });

  it("works when onRefresh is not provided", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/refresh",
        method: "POST",
      })
    );

    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ queued: true });
  });

  it("awaits async refresh completion before returning", async () => {
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
      createOptions({
        pathname: "/api/v1/refresh",
        method: "POST",
        onRefresh,
      })
    );

    expect(released).toBe(true);
    expect(result.status).toBe(202);
  });

  it("coalesces concurrent refresh requests while one is running", async () => {
    let resolveRefresh: (() => void) | null = null;
    const onRefresh = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const first = resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/refresh",
        method: "POST",
        onRefresh,
      })
    );
    const second = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/refresh",
        method: "POST",
        onRefresh,
      })
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
    const onRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce(undefined);

    await expect(
      resolveOrchestratorStatusResponse(
        createOptions({
          pathname: "/api/v1/refresh",
          method: "POST",
          onRefresh,
        })
      )
    ).resolves.toEqual({
      status: 500,
      payload: { error: "refresh failed" },
    });

    await expect(
      resolveOrchestratorStatusResponse(
        createOptions({
          pathname: "/api/v1/refresh",
          method: "POST",
          onRefresh,
        })
      )
    ).resolves.toEqual({
      status: 202,
      payload: { queued: true },
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/v1/status", () => {
  it("returns a single project snapshot", async () => {
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
      rateLimits: {
        source: "codex",
        remaining: 42,
      },
      lastError: null,
    } as const;
    const getProjectStatus = vi.fn().mockResolvedValue(snapshot);

    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/status",
        getProjectStatus,
      })
    );

    expect(result.status).toBe(200);
    expect(result.payload).toEqual(snapshot);
    expect(getProjectStatus).toHaveBeenCalledOnce();
  });

  it("returns 405 for non-GET methods", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/status",
        method: "POST",
      })
    );

    expect(result).toEqual({
      status: 405,
      payload: { error: "Method not allowed" },
    });
  });
});

describe("GET /api/v1/<issue_identifier>", () => {
  it("returns issue-specific status for URL-encoded identifiers", async () => {
    const payload = {
      issue_identifier: "acme/repo#123",
      issue_id: "issue-123",
      status: "running",
      workspace: { path: "/tmp/workspace" },
      attempts: {
        restart_count: 1,
        current_retry_attempt: 2,
      },
      running: {
        session_id: "session-1",
        turn_count: 7,
        state: "In Progress",
        started_at: "2026-03-16T00:00:00.000Z",
        last_event: "notification",
        last_message: "Working on tests",
        last_event_at: "2026-03-16T00:10:00.000Z",
        tokens: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      },
      retry: null,
      logs: {
        codex_session_logs: [],
      },
      recent_events: [],
      last_error: null,
      tracked: {},
    } as const;
    const getIssueStatus = vi.fn().mockResolvedValue(payload);

    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/acme%2Frepo%23123",
        getIssueStatus,
      })
    );

    expect(result.status).toBe(200);
    expect(result.payload).toEqual(payload);
    expect(getIssueStatus).toHaveBeenCalledWith("acme/repo#123");
  });

  it("returns issue_not_found for unknown issues", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/acme%2Frepo%23999",
        getIssueStatus: vi.fn().mockResolvedValue(null),
      })
    );

    expect(result).toEqual({
      status: 404,
      payload: {
        error: {
          code: "issue_not_found",
          message:
            'Issue "acme/repo#999" is unknown to the current in-memory state.',
        },
      },
    });
  });

  it("returns 400 for malformed URL-encoded identifiers", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/%E0%A4%A",
        getIssueStatus: vi.fn(),
      })
    );

    expect(result).toEqual({
      status: 400,
      payload: {
        error: {
          code: "invalid_issue_identifier",
          message: "Issue identifier path segment is not valid URL encoding.",
        },
      },
    });
  });

  it("returns 501 when issue lookup is not configured", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/acme%2Frepo%23123",
      })
    );

    expect(result).toEqual({
      status: 501,
      payload: {
        error: {
          code: "issue_status_not_supported",
          message: "Issue status lookup is not configured.",
        },
      },
    });
  });

  it("returns 405 for non-GET methods on issue-specific routes", async () => {
    const result = await resolveOrchestratorStatusResponse(
      createOptions({
        pathname: "/api/v1/acme%2Frepo%23123",
        method: "POST",
        getIssueStatus: vi.fn(),
      })
    );

    expect(result).toEqual({
      status: 405,
      payload: { error: "Method not allowed" },
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolveDashboardResponse } from "./server.js";

function createReader() {
  return {
    loadProjectStatus: vi.fn().mockResolvedValue(null),
    loadProjectIssueOrchestrations: vi.fn().mockResolvedValue([]),
    loadRun: vi.fn(),
    loadAllRuns: vi.fn(),
    loadRecentRunEvents: vi.fn(),
    projectId: "tenant-1",
    runtimeRoot: "/tmp/runtime",
    projectDir: vi.fn(),
    runDir: vi.fn(),
  };
}

describe("GET /api/v1/state", () => {
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
    const reader = createReader();
    reader.loadProjectStatus.mockResolvedValue(snapshot);

    const result = await resolveDashboardResponse({
      pathname: "/api/v1/state",
      reader: reader as never,
    });

    expect(result.status).toBe(200);
    expect(result.payload).toEqual(snapshot);
    expect(reader.loadProjectStatus).toHaveBeenCalledOnce();
  });

  it("returns 405 for non-GET methods", async () => {
    const result = await resolveDashboardResponse({
      pathname: "/api/v1/state",
      method: "POST",
      reader: createReader() as never,
    });

    expect(result).toEqual({
      status: 405,
      payload: { error: "Method not allowed" },
    });
  });
});

describe("GET /api/v1/<issue_identifier>", () => {
  it("returns issue-specific status for URL-encoded identifiers", async () => {
    const reader = createReader();
    reader.loadProjectIssueOrchestrations.mockResolvedValue([
      {
        issueId: "issue-123",
        identifier: "acme/repo#123",
        workspaceKey: "acme_repo_123",
        state: "running",
        currentRunId: "run-1",
        retryEntry: null,
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
    ]);
    reader.loadRun.mockResolvedValue({
      runId: "run-1",
      projectId: "tenant-1",
      projectSlug: "tenant-1",
      issueId: "issue-123",
      issueSubjectId: "issue-123",
      issueIdentifier: "acme/repo#123",
      issueState: "In Progress",
      repository: {
        owner: "acme",
        name: "repo",
        cloneUrl: "https://github.com/acme/repo.git",
      },
      status: "running",
      attempt: 2,
      processId: null,
      port: null,
      workingDirectory: "/tmp/workspace",
      issueWorkspaceKey: "acme_repo_123",
      workspaceRuntimeDir: "/tmp/runtime",
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:10:00.000Z",
      startedAt: "2026-03-16T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      runtimeSession: {
        sessionId: "session-1",
        threadId: "thread-1",
        status: "active",
        startedAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:10:00.000Z",
        exitClassification: null,
      },
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      turnCount: 7,
      lastEvent: "notification",
      lastEventAt: "2026-03-16T00:10:00.000Z",
    });
    reader.loadRecentRunEvents.mockResolvedValue([]);
    reader.runDir.mockReturnValue("/tmp/runtime/projects/tenant-1/runs/run-1");

    const result = await resolveDashboardResponse({
      pathname: "/api/v1/acme%2Frepo%23123",
      reader: reader as never,
    });

    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      issue_identifier: "acme/repo#123",
      issue_id: "issue-123",
      status: "running",
      workspace: { path: "/tmp/workspace" },
    });
  });

  it("returns 400 for invalid URL encoding", async () => {
    const result = await resolveDashboardResponse({
      pathname: "/api/v1/%E0%A4%A",
      reader: createReader() as never,
    });

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

  it("returns 404 when the issue is unknown", async () => {
    const result = await resolveDashboardResponse({
      pathname: "/api/v1/acme%2Frepo%23123",
      reader: createReader() as never,
    });

    expect(result).toEqual({
      status: 404,
      payload: {
        error: {
          code: "issue_not_found",
          message:
            'Issue "acme/repo#123" is unknown to the current filesystem state.',
        },
      },
    });
  });
});

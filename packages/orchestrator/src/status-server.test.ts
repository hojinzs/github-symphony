import { describe, expect, it } from "vitest";
import { resolveOrchestratorStatusResponse } from "./status-server.js";

describe("orchestrator status server", () => {
  const workspaceSnapshot = {
    workspaceId: "workspace-1",
    slug: "workspace-1",
    tracker: {
      adapter: "github-project",
      bindingId: "project-123"
    },
    lastTickAt: "2026-03-09T00:00:00.000Z",
    health: "running" as const,
    summary: {
      dispatched: 1,
      suppressed: 0,
      recovered: 0,
      activeRuns: 1
    },
    activeRuns: [
      {
        runId: "run-1",
        issueIdentifier: "acme/platform#1",
        phase: "planning",
        status: "running",
        retryKind: null,
        port: 4601
      }
    ],
    retryQueue: [],
    lastError: null
  };

  it("resolves workspace status snapshots and not-found responses", async () => {
    const resolved = await resolveOrchestratorStatusResponse(
      "/api/v1/workspaces/workspace-1/status",
      {
        all: async () => [workspaceSnapshot],
        byWorkspaceId: async (workspaceId) =>
          workspaceId === "workspace-1" ? workspaceSnapshot : null
      }
    );

    expect(resolved.status).toBe(200);
    expect(resolved.payload).toMatchObject({
      workspaceId: "workspace-1",
      health: "running"
    });

    const notFound = await resolveOrchestratorStatusResponse(
      "/api/v1/workspaces/missing/status",
      {
        all: async () => [workspaceSnapshot],
        byWorkspaceId: async () => null
      }
    );

    expect(notFound.status).toBe(404);
  });
});

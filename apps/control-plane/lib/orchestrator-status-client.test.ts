import { describe, expect, it, vi } from "vitest";
import {
  fetchWorkspaceOrchestratorStatus,
  resolveOrchestratorStatusBaseUrl
} from "./orchestrator-status-client";

describe("orchestrator status client", () => {
  it("uses the configured base URL and parses workspace snapshots", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaceId: "workspace-1",
          slug: "workspace-1",
          tracker: {
            adapter: "github-project",
            bindingId: "project-123"
          },
          lastTickAt: "2026-03-09T00:00:00.000Z",
          health: "running",
          summary: {
            dispatched: 1,
            suppressed: 0,
            recovered: 0,
            activeRuns: 1
          },
          activeRuns: [],
          lastError: null
        }),
        { status: 200 }
      )
    );

    const snapshot = await fetchWorkspaceOrchestratorStatus("workspace-1", {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: "http://orchestrator.test:4680"
    });

    expect(snapshot?.workspaceId).toBe("workspace-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://orchestrator.test:4680/api/v1/workspaces/workspace-1/status"
    );
  });

  it("returns null for 404 responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const snapshot = await fetchWorkspaceOrchestratorStatus("missing", {
      fetchImpl: fetchImpl as typeof fetch
    });

    expect(snapshot).toBeNull();
  });

  it("defaults the base URL for colocated control-plane deployments", () => {
    expect(
      resolveOrchestratorStatusBaseUrl({
        ORCHESTRATOR_STATUS_BASE_URL: "http://127.0.0.1:9999"
      } as unknown as NodeJS.ProcessEnv)
    ).toBe("http://127.0.0.1:9999");
  });
});

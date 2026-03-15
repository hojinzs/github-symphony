import { describe, expect, it, vi } from "vitest";
import {
  fetchProjectOrchestratorStatus,
  resolveOrchestratorStatusBaseUrl
} from "./orchestrator-status-client";

describe("orchestrator status client", () => {
  it("uses the configured base URL and parses project snapshots", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          projectId: "tenant-1",
          slug: "tenant-1",
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
          retryQueue: [],
          lastError: null
        }),
        { status: 200 }
      )
    );

    const snapshot = await fetchProjectOrchestratorStatus("tenant-1", {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: "http://orchestrator.test:4680"
    });

    expect(snapshot?.projectId).toBe("tenant-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://orchestrator.test:4680/api/v1/status"
    );
  });

  it("returns null for 404 responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const snapshot = await fetchProjectOrchestratorStatus("missing", {
      fetchImpl: fetchImpl as typeof fetch
    });

    expect(snapshot).toBeNull();
  });

  it("returns null when the snapshot projectId does not match the requested workspace", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          projectId: "tenant-2",
          slug: "tenant-2",
          tracker: {
            adapter: "github-project",
            bindingId: "project-456"
          },
          lastTickAt: "2026-03-09T00:00:00.000Z",
          health: "running",
          summary: {
            dispatched: 0,
            suppressed: 0,
            recovered: 0,
            activeRuns: 0
          },
          activeRuns: [],
          retryQueue: [],
          lastError: null
        }),
        { status: 200 }
      )
    );

    const snapshot = await fetchProjectOrchestratorStatus("tenant-1", {
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

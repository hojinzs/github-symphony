import { describe, expect, it, vi } from "vitest";
import {
  acquireTurnLease,
  refreshTrackerState,
  reportTrackerRefresh,
  resolveRefreshFailureThreshold,
  resolveTrackerRefreshGate,
  updateRefreshFailureCount,
} from "./turn-lease.js";

describe("worker turn lease", () => {
  it("acquires a lease for the exact issue/run before a turn", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          acquired: true,
          expiresAt: "2026-07-15T00:00:15.000Z",
        }),
        { status: 200 }
      )
    );

    await expect(
      acquireTurnLease(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_ISSUE_ID: "issue-1",
          SYMPHONY_RUN_ID: "run-1",
        },
        2,
        fetchImpl
      )
    ).resolves.toEqual({
      status: "acquired",
      expiresAt: "2026-07-15T00:00:15.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4680/api/v1/worker-turn-lease",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer worker-api-token",
        }),
        body: JSON.stringify({ issueId: "issue-1", runId: "run-1", turn: 2 }),
      })
    );
  });

  it("fails closed when a superseded worker is denied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "run_not_current" }), {
        status: 409,
      })
    );

    await expect(
      acquireTurnLease(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_ISSUE_ID: "issue-1",
          SYMPHONY_RUN_ID: "old-run",
        },
        1,
        fetchImpl
      )
    ).resolves.toEqual({ status: "denied", reason: "run_not_current" });
  });

  it("classifies an unreachable orchestrator as unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      acquireTurnLease(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_ISSUE_ID: "issue-1",
          SYMPHONY_RUN_ID: "run-1",
        },
        1,
        fetchImpl
      )
    ).resolves.toEqual({
      status: "unavailable",
      reason: "ECONNREFUSED",
    });
  });

  it("reports a missing worker API token", async () => {
    await expect(
      acquireTurnLease(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ISSUE_ID: "issue-1",
          SYMPHONY_RUN_ID: "run-1",
        },
        1
      )
    ).resolves.toEqual({
      status: "unavailable",
      reason: "missing orchestrator URL, token, or worker run identity",
    });
  });
});

describe("tracker refresh fail-closed threshold", () => {
  it("uses one production gate decision for transient thresholds and unsupported reads", () => {
    expect(resolveTrackerRefreshGate("unknown", 0, 2)).toEqual({
      action: "continue",
      count: 1,
    });
    expect(resolveTrackerRefreshGate("unknown", 1, 2)).toEqual({
      action: "fail-closed",
      count: 2,
    });
    expect(resolveTrackerRefreshGate("unsupported", 1, 2)).toEqual({
      action: "skip",
      count: 1,
    });
    expect(resolveTrackerRefreshGate("non-actionable", 1, 2)).toEqual({
      action: "complete",
      count: 0,
    });
    expect(resolveTrackerRefreshGate("active", 1, 2)).toEqual({
      action: "continue",
      count: 0,
    });
  });

  it("accepts local convergence when a tracker read is permanently unsupported", () => {
    expect(
      resolveTrackerRefreshGate("unsupported", 2, 3, "convergence")
    ).toEqual({
      action: "converge",
      count: 2,
    });
  });

  it("logs unsupported capability diagnostics on every read but warns once", () => {
    const messages: string[] = [];
    const result = {
      state: "unsupported" as const,
      diagnostic: {
        message: "tracker state requests unsupported",
        httpStatus: 403,
        providerError: "tracker_state_requests_unsupported",
      },
    };
    let warningLogged = reportTrackerRefresh(
      result,
      "tracker state refresh",
      false,
      (message) => messages.push(message)
    );
    warningLogged = reportTrackerRefresh(
      result,
      "tracker state refresh",
      warningLogged,
      (message) => messages.push(message)
    );

    expect(warningLogged).toBe(true);
    expect(
      messages.filter((message) => message.includes("capability unavailable"))
    ).toHaveLength(1);
    expect(
      messages.filter((message) => message.includes("HTTP 403"))
    ).toHaveLength(2);
  });

  it("returns a distinct diagnostic when the orchestrator endpoint is missing", async () => {
    await expect(refreshTrackerState({}, ["Ready"])).resolves.toEqual({
      state: "unknown",
      diagnostic: { message: "orchestrator endpoint not configured" },
    });
  });

  it("classifies unsupported tracker state requests without fail-closing or resetting the transient streak", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          outcome: "rejected",
          error: "tracker_state_requests_unsupported",
        }),
        { status: 403 }
      )
    );

    const result = await refreshTrackerState(
      {
        SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
        SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
        SYMPHONY_RUN_ID: "run-1",
      },
      ["Ready"],
      fetchImpl
    );

    expect(result).toEqual({
      state: "unsupported",
      diagnostic: {
        message: "tracker state requests unsupported",
        httpStatus: 403,
        providerError: "tracker_state_requests_unsupported",
      },
    });
    expect(updateRefreshFailureCount(result.state, 2, 3)).toEqual({
      count: 2,
      failClosed: false,
    });
  });

  it("preserves HTTP and provider diagnostics for transient failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          outcome: "failed",
          error: "provider unavailable",
        }),
        { status: 503 }
      )
    );

    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready"],
        fetchImpl
      )
    ).resolves.toEqual({
      state: "unknown",
      diagnostic: {
        message: "tracker state request failed",
        httpStatus: 503,
        providerError: "provider unavailable",
      },
    });
  });

  it("preserves exception diagnostics for transient failures", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("request timed out"));

    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready"],
        fetchImpl
      )
    ).resolves.toEqual({
      state: "unknown",
      diagnostic: {
        message: "tracker state request failed",
        exceptionMessage: "request timed out",
      },
    });
  });

  it("checks canonical tracker state through the authenticated endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          outcome: "confirmed",
          state: "LAND",
          routable: true,
        })
      )
    );

    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready", "Land"],
        fetchImpl
      )
    ).resolves.toEqual({ state: "active", diagnostic: null });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4680/api/v1/tracker-state",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-symphony-run-id": "run-1",
          "x-symphony-orchestrator-token": "worker-api-token",
        }),
        body: JSON.stringify({ type: "state-read" }),
      })
    );
  });

  it("returns non-actionable only for a confirmed state outside active states", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          outcome: "confirmed",
          state: "Done",
          routable: true,
        })
      )
    );

    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready", "In progress", "Land"],
        fetchImpl
      )
    ).resolves.toEqual({ state: "non-actionable", diagnostic: null });
  });

  it("fails closed when the canonical tracker response is unconfirmed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, state: "Done" }))
      );

    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready"],
        fetchImpl
      )
    ).resolves.toEqual({
      state: "unknown",
      diagnostic: {
        message: "invalid tracker state response",
        httpStatus: 200,
      },
    });
  });

  it("returns non-actionable when a refreshed active issue is not routable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          outcome: "confirmed",
          state: "In progress",
          routable: false,
          routableReason: 'Issue is missing required labels ("agent").',
        })
      )
    );

    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready", "In progress", "Land"],
        fetchImpl
      )
    ).resolves.toEqual({ state: "non-actionable", diagnostic: null });
    expect(errorSpy).toHaveBeenCalledWith(
      '[worker] issue no longer routable: Issue is missing required labels ("agent").'
    );
    errorSpy.mockRestore();
  });

  it("fails closed when a confirmed read lacks a routability decision", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          outcome: "confirmed",
          state: "In progress",
        })
      )
    );

    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready", "In progress", "Land"],
        fetchImpl
      )
    ).resolves.toEqual({
      state: "unknown",
      diagnostic: {
        message: "invalid tracker state response",
        httpStatus: 200,
      },
    });
  });

  it("returns unknown on transport failure for threshold accounting", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
    await expect(
      refreshTrackerState(
        {
          SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
          SYMPHONY_ORCHESTRATOR_TOKEN: "worker-api-token",
          SYMPHONY_RUN_ID: "run-1",
        },
        ["Ready"],
        fetchImpl
      )
    ).resolves.toEqual({
      state: "unknown",
      diagnostic: {
        message: "tracker state request failed",
        exceptionMessage: "network error",
      },
    });
  });

  it("uses a positive configured threshold and rejects unsafe values", () => {
    expect(resolveRefreshFailureThreshold("2")).toBe(2);
    expect(resolveRefreshFailureThreshold("0")).toBe(3);
    expect(resolveRefreshFailureThreshold("invalid")).toBe(3);
  });

  it("fails closed on the configured consecutive refresh failure", () => {
    const first = updateRefreshFailureCount("unknown", 0, 2);
    const second = updateRefreshFailureCount("unknown", first.count, 2);
    const recovered = updateRefreshFailureCount("active", second.count, 2);

    expect(first).toEqual({ count: 1, failClosed: false });
    expect(second).toEqual({ count: 2, failClosed: true });
    expect(recovered).toEqual({ count: 0, failClosed: false });
  });
});

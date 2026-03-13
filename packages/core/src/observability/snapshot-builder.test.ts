import { describe, it, expect } from "vitest";
import { buildTenantSnapshot, type SnapshotInput } from "./snapshot-builder.js";
import type {
  OrchestratorTenantConfig,
  OrchestratorRunRecord,
} from "../contracts/status-surface.js";

/**
 * Helper to create a minimal OrchestratorTenantConfig for testing
 */
function mockTenant(
  overrides?: Partial<OrchestratorTenantConfig>
): OrchestratorTenantConfig {
  return {
    tenantId: "tenant-123",
    slug: "test-tenant",
    repositories: [
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    ],
    tracker: {
      adapter: "github",
      bindingId: "binding-456",
    },
    runtime: {
      driver: "local",
      workspaceRuntimeDir: "/tmp/runtime",
      projectRoot: "/tmp/project",
    },
    ...overrides,
  };
}

/**
 * Helper to create a minimal OrchestratorRunRecord for testing
 */
function mockRun(
  overrides?: Partial<OrchestratorRunRecord>
): OrchestratorRunRecord {
  return {
    runId: "run-001",
    tenantId: "tenant-123",
    tenantSlug: "test-tenant",
    issueId: "issue-001",
    issueSubjectId: "subject-001",
    issueIdentifier: "acme/platform#42",
    issueState: "In Progress",
    repository: {
      owner: "acme",
      name: "platform",
      cloneUrl: "https://github.com/acme/platform.git",
    },
    status: "running",
    attempt: 1,
    processId: 12345,
    port: 5000,
    workingDirectory: "/tmp/work",
    issueWorkspaceKey: "key-001",
    workspaceRuntimeDir: "/tmp/runtime",
    workflowPath: "WORKFLOW.md",
    retryKind: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:05:00Z",
    startedAt: "2024-01-01T00:01:00Z",
    completedAt: null,
    lastError: null,
    nextRetryAt: null,
    ...overrides,
  };
}

describe("buildTenantSnapshot", () => {
  it("returns idle health when no active runs and no error", () => {
    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.health).toBe("idle");
    expect(snapshot.activeRuns).toHaveLength(0);
    expect(snapshot.retryQueue).toHaveLength(0);
    expect(snapshot.summary.activeRuns).toBe(0);
  });

  it("returns running health when active runs present", () => {
    const run = mockRun({ status: "running" });
    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.health).toBe("running");
    expect(snapshot.activeRuns).toHaveLength(1);
    expect(snapshot.activeRuns[0].runId).toBe("run-001");
    expect(snapshot.activeRuns[0].issueIdentifier).toBe("acme/platform#42");
    expect(snapshot.summary.activeRuns).toBe(1);
  });

  it("returns degraded health when lastError is present", () => {
    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: "Worker process crashed unexpectedly",
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.health).toBe("degraded");
    expect(snapshot.lastError).toBe("Worker process crashed unexpectedly");
  });

  it("prioritizes degraded over running when both error and active runs present", () => {
    const run = mockRun({ status: "running" });
    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: "Critical error occurred",
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.health).toBe("degraded");
  });

  it("partitions retrying runs into retryQueue", () => {
    const runningRun = mockRun({
      runId: "run-001",
      status: "running",
      retryKind: null,
    });
    const retryingRun = mockRun({
      runId: "run-002",
      status: "retrying",
      retryKind: "failure",
      nextRetryAt: "2024-01-01T00:15:00Z",
    });
    const anotherRetrying = mockRun({
      runId: "run-003",
      status: "retrying",
      retryKind: "recovery",
      nextRetryAt: "2024-01-01T00:20:00Z",
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [runningRun, retryingRun, anotherRetrying],
      summary: { dispatched: 3, suppressed: 0, recovered: 1 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.activeRuns).toHaveLength(3);
    expect(snapshot.retryQueue).toHaveLength(2);
    expect(snapshot.retryQueue[0].runId).toBe("run-002");
    expect(snapshot.retryQueue[0].retryKind).toBe("failure");
    expect(snapshot.retryQueue[1].runId).toBe("run-003");
    expect(snapshot.retryQueue[1].retryKind).toBe("recovery");
  });

  it("aggregates token usage across multiple runs", () => {
    const run1 = mockRun({
      runId: "run-001",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:05:00Z",
    });
    const run2 = mockRun({
      runId: "run-002",
      tokenUsage: {
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
      },
      startedAt: "2024-01-01T00:06:00Z",
      completedAt: null,
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run1, run2],
      allRuns: [run1, run2],
      summary: { dispatched: 2, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.codexTotals!.inputTokens).toBe(3000);
    expect(snapshot.codexTotals!.outputTokens).toBe(1500);
    expect(snapshot.codexTotals!.totalTokens).toBe(4500);
    expect(snapshot.codexTotals!.secondsRunning).toBeGreaterThan(0);
  });

  it("handles runs with missing tokenUsage gracefully", () => {
    const runWithTokens = mockRun({
      runId: "run-001",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    });
    const runWithoutTokens = mockRun({
      runId: "run-002",
      tokenUsage: undefined,
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [runWithTokens, runWithoutTokens],
      allRuns: [runWithTokens, runWithoutTokens],
      summary: { dispatched: 2, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.codexTotals!.inputTokens).toBe(1000);
    expect(snapshot.codexTotals!.outputTokens).toBe(500);
    expect(snapshot.codexTotals!.totalTokens).toBe(1500);
  });

  it("handles runs with missing runtimeSession gracefully", () => {
    const runWithSession = mockRun({
      runId: "run-001",
      runtimeSession: {
        sessionId: "session-001",
        threadId: "thread-001",
        status: "active",
        startedAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:05:00Z",
        exitClassification: null,
      },
    });
    const runWithoutSession = mockRun({
      runId: "run-002",
      runtimeSession: undefined,
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [runWithSession, runWithoutSession],
      summary: { dispatched: 2, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    // Verify no crash when runs have/lack runtimeSession
    expect(snapshot.activeRuns).toHaveLength(2);
  });

  it("preserves tenant metadata in snapshot", () => {
    const tenant = mockTenant({
      tenantId: "custom-tenant-id",
      slug: "custom-slug",
      tracker: {
        adapter: "github",
        bindingId: "custom-binding",
      },
    });

    const input: SnapshotInput = {
      tenant,
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.tenantId).toBe("custom-tenant-id");
    expect(snapshot.slug).toBe("custom-slug");
    expect(snapshot.tracker.adapter).toBe("github");
    expect(snapshot.tracker.bindingId).toBe("custom-binding");
  });

  it("includes summary counts in snapshot", () => {
    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [],
      summary: { dispatched: 5, suppressed: 2, recovered: 1 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.summary.dispatched).toBe(5);
    expect(snapshot.summary.suppressed).toBe(2);
    expect(snapshot.summary.recovered).toBe(1);
  });

  it("uses allRuns for token aggregation when provided, falls back to activeRuns", () => {
    const activeRun = mockRun({
      runId: "run-001",
      status: "running",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    });
    const completedRun = mockRun({
      runId: "run-002",
      status: "succeeded",
      tokenUsage: {
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
      },
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [activeRun],
      allRuns: [activeRun, completedRun],
      summary: { dispatched: 2, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    // Should aggregate from allRuns, not just activeRuns
    expect(snapshot.codexTotals!.inputTokens).toBe(3000);
    expect(snapshot.codexTotals!.outputTokens).toBe(1500);
    expect(snapshot.codexTotals!.totalTokens).toBe(4500);
  });

  it("falls back to activeRuns for token aggregation when allRuns not provided", () => {
    const run = mockRun({
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      // allRuns not provided
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.codexTotals!.inputTokens).toBe(1000);
    expect(snapshot.codexTotals!.outputTokens).toBe(500);
    expect(snapshot.codexTotals!.totalTokens).toBe(1500);
  });

  it("handles rateLimits when provided", () => {
    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
      rateLimits: {
        remaining: 4500,
        limit: 5000,
        resetAt: "2024-01-01T01:00:00Z",
      },
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.rateLimits).toEqual({
      remaining: 4500,
      limit: 5000,
      resetAt: "2024-01-01T01:00:00Z",
    });
  });

  it("defaults rateLimits to null when not provided", () => {
    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
      // rateLimits not provided
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.rateLimits).toBeNull();
  });

  it("maps all activeRun fields correctly", () => {
    const run = mockRun({
      runId: "run-123",
      issueIdentifier: "acme/platform#99",
      issueState: "Approved",
      status: "running",
      retryKind: null,
      port: 5001,
      runtimeSession: {
        sessionId: "session-abc",
        threadId: "thread-xyz",
        status: "active",
        startedAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:05:00Z",
        exitClassification: null,
      },
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.activeRuns[0]).toMatchObject({
      runId: "run-123",
      issueIdentifier: "acme/platform#99",
      issueState: "Approved",
      status: "running",
      retryKind: null,
      port: 5001,
    });
  });

  it("calculates secondsRunning correctly from startedAt and completedAt", () => {
    const run = mockRun({
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:10:00Z",
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      allRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:15:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    // 10 minutes = 600 seconds
    expect(snapshot.codexTotals!.secondsRunning).toBe(600);
  });

  it("uses lastTickAt as end time when completedAt is null", () => {
    const run = mockRun({
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: null,
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      allRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:05:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    // 5 minutes = 300 seconds
    expect(snapshot.codexTotals!.secondsRunning).toBe(300);
  });

  it("handles retrying run with null retryKind by defaulting to 'failure'", () => {
    const run = mockRun({
      status: "retrying",
      retryKind: null,
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    // retrying status without retryKind should not appear in retryQueue
    expect(snapshot.retryQueue).toHaveLength(0);
  });

  it("passes through processId, turnCount, startedAt, lastEvent, lastEventAt, tokenUsage to activeRuns", () => {
    const run = mockRun({
      runId: "run-live-001",
      processId: 54321,
      turnCount: 5,
      startedAt: "2024-01-01T00:01:00Z",
      lastEvent: "Analyzing code structure",
      lastEventAt: "2024-01-01T00:04:30Z",
      tokenUsage: {
        inputTokens: 2500,
        outputTokens: 1200,
        totalTokens: 3700,
      },
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.activeRuns).toHaveLength(1);
    expect(snapshot.activeRuns[0].processId).toBe(54321);
    expect(snapshot.activeRuns[0].turnCount).toBe(5);
    expect(snapshot.activeRuns[0].startedAt).toBe("2024-01-01T00:01:00Z");
    expect(snapshot.activeRuns[0].lastEvent).toBe("Analyzing code structure");
    expect(snapshot.activeRuns[0].lastEventAt).toBe("2024-01-01T00:04:30Z");
    expect(snapshot.activeRuns[0].tokenUsage?.inputTokens).toBe(2500);
    expect(snapshot.activeRuns[0].tokenUsage?.outputTokens).toBe(1200);
    expect(snapshot.activeRuns[0].tokenUsage?.totalTokens).toBe(3700);
  });

  it("sets live fields to null/undefined when missing from run record", () => {
    const run = mockRun({
      runId: "run-live-002",
      processId: null,
      turnCount: undefined,
      startedAt: null,
      lastEvent: undefined,
      lastEventAt: null,
      tokenUsage: undefined,
    });

    const input: SnapshotInput = {
      tenant: mockTenant(),
      activeRuns: [run],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2024-01-01T00:10:00Z",
      lastError: null,
    };

    const snapshot = buildTenantSnapshot(input);

    expect(snapshot.activeRuns).toHaveLength(1);
    expect(snapshot.activeRuns[0].processId).toBeNull();
    expect(snapshot.activeRuns[0].turnCount).toBeUndefined();
    expect(snapshot.activeRuns[0].startedAt).toBeNull();
    expect(snapshot.activeRuns[0].lastEvent).toBeNull();
    expect(snapshot.activeRuns[0].lastEventAt).toBeNull();
    expect(snapshot.activeRuns[0].tokenUsage).toBeUndefined();
  });
});

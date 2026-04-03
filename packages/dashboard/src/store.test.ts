import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DashboardFsReader, statusForIssue } from "./store.js";

describe("DashboardFsReader", () => {
  it("rejects project IDs that would escape the runtime root", () => {
    expect(() => new DashboardFsReader("/tmp/runtime", "../tenant-1")).toThrow(
      'Invalid project ID "../tenant-1"'
    );
  });

  it("rejects run IDs that would escape the runtime root", async () => {
    const reader = new DashboardFsReader("/tmp/runtime", "tenant-1");

    await expect(reader.loadRun("../run-1")).rejects.toThrow(
      'Invalid run ID "../run-1"'
    );
    await expect(reader.loadRecentRunEvents("../run-1")).rejects.toThrow(
      'Invalid run ID "../run-1"'
    );
  });

  it("reads project status snapshots from the runtime root", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const projectDir = join(runtimeRoot, "projects", "tenant-1");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "status.json"),
      JSON.stringify({
        projectId: "tenant-1",
        slug: "tenant-1",
        tracker: { adapter: "github-project", bindingId: "project-1" },
        lastTickAt: "2026-03-20T00:00:00.000Z",
        health: "idle",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      }) + "\n",
      "utf8"
    );

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(reader.loadProjectStatus()).resolves.toMatchObject({
      projectId: "tenant-1",
      health: "idle",
    });
  });

  it("assembles issue status snapshots from persisted runtime files", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const projectDir = join(runtimeRoot, "projects", "tenant-1");
    const runDir = join(projectDir, "runs", "run-1");
    const priorRunDir = join(projectDir, "runs", "run-0");
    await mkdir(runDir, { recursive: true });
    await mkdir(priorRunDir, { recursive: true });

    await writeFile(
      join(projectDir, "issues.json"),
      JSON.stringify([
        {
          issueId: "issue-1",
          identifier: "acme/platform#1",
          workspaceKey: "acme_platform_1",
          completedOnce: true,
          failureRetryCount: 0,
          state: "retry_queued",
          currentRunId: "run-1",
          retryEntry: {
            attempt: 2,
            dueAt: "2026-03-20T00:03:00.000Z",
            error: "worker failed",
          },
          updatedAt: "2026-03-20T00:02:00.000Z",
        },
      ]) + "\n",
      "utf8"
    );
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run-1",
        projectId: "tenant-1",
        projectSlug: "tenant-1",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/platform#1",
        issueState: "In Progress",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        status: "retrying",
        attempt: 2,
        processId: null,
        port: 4601,
        workingDirectory: join(runtimeRoot, "workspace", "run-1"),
        issueWorkspaceKey: "acme_platform_1",
        workspaceRuntimeDir: join(runDir, "workspace-runtime"),
        workflowPath: null,
        retryKind: "failure",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:02:00.000Z",
        startedAt: "2026-03-20T00:00:00.000Z",
        completedAt: null,
        lastError: "worker failed",
        nextRetryAt: "2026-03-20T00:03:00.000Z",
        runtimeSession: {
          sessionId: "session-1",
          threadId: "thread-1",
          status: "active",
          startedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:02:00.000Z",
          exitClassification: null,
        },
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 40,
          totalTokens: 160,
        },
        turnCount: 4,
        lastEvent: "worker-error",
        lastEventAt: "2026-03-20T00:02:00.000Z",
        executionPhase: "implementation",
        runPhase: "failed",
      }) + "\n",
      "utf8"
    );
    await writeFile(
      join(priorRunDir, "run.json"),
      JSON.stringify({
        runId: "run-0",
        projectId: "tenant-1",
        projectSlug: "tenant-1",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/platform#1",
        issueState: "Done",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        status: "succeeded",
        attempt: 1,
        processId: null,
        port: null,
        workingDirectory: join(runtimeRoot, "workspace", "run-0"),
        issueWorkspaceKey: "acme_platform_1",
        workspaceRuntimeDir: join(priorRunDir, "workspace-runtime"),
        workflowPath: null,
        retryKind: null,
        createdAt: "2026-03-19T23:50:00.000Z",
        updatedAt: "2026-03-19T23:59:00.000Z",
        startedAt: "2026-03-19T23:50:00.000Z",
        completedAt: "2026-03-19T23:59:00.000Z",
        lastError: null,
        nextRetryAt: null,
        tokenUsage: {
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
        },
      }) + "\n",
      "utf8"
    );
    await appendFile(
      join(runDir, "events.ndjson"),
      JSON.stringify({
        at: "2026-03-20T00:02:00.000Z",
        event: "worker-error",
        runId: "run-1",
        issueIdentifier: "acme/platform#1",
        error: "worker failed",
        attempt: 2,
      }) + "\n",
      "utf8"
    );

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(statusForIssue(reader, "acme/platform#1")).resolves.toEqual({
      issue_identifier: "acme/platform#1",
      issue_id: "issue-1",
      status: "retrying",
      workspace: {
        path: join(runtimeRoot, "workspace", "run-1"),
      },
      attempts: {
        restart_count: 1,
        current_retry_attempt: 2,
      },
      running: {
        session_id: "session-1",
        turn_count: 4,
        state: "In Progress",
        started_at: "2026-03-20T00:00:00.000Z",
        last_event: "worker-error",
        last_message: "worker failed",
        last_event_at: "2026-03-20T00:02:00.000Z",
        tokens: {
          input_tokens: 120,
          output_tokens: 40,
          total_tokens: 160,
          cumulative_input_tokens: 200,
          cumulative_output_tokens: 60,
          cumulative_total_tokens: 260,
        },
      },
      retry: {
        due_at: "2026-03-20T00:03:00.000Z",
        kind: "failure",
        error: "worker failed",
      },
      logs: {
        codex_session_logs: [
          {
            label: "worker",
            path: join(runDir, "worker.log"),
            url: null,
          },
        ],
      },
      recent_events: [
        {
          at: "2026-03-20T00:02:00.000Z",
          event: "worker-error",
          message: "worker failed",
        },
      ],
      last_error: "worker failed",
      tracked: {
        issue_orchestration_state: "retry_queued",
        current_run_id: "run-1",
        workspace_key: "acme_platform_1",
        completed_once: true,
        run_phase: "failed",
        execution_phase: "implementation",
      },
    });
  });

  it("falls back to the latest matching run when currentRunId is stale", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const projectDir = join(runtimeRoot, "projects", "tenant-1");
    const runsDir = join(projectDir, "runs");
    await mkdir(runsDir, { recursive: true });

    await writeFile(
      join(projectDir, "issues.json"),
      JSON.stringify([
        {
          issueId: "issue-1",
          identifier: "acme/platform#1",
          workspaceKey: "acme_platform_1",
          completedOnce: false,
          failureRetryCount: 0,
          state: "running",
          currentRunId: "missing-run",
          retryEntry: null,
          updatedAt: "2026-03-20T00:02:00.000Z",
        },
      ]) + "\n",
      "utf8"
    );
    await mkdir(join(runsDir, "run-2"), { recursive: true });
    await writeFile(
      join(runsDir, "run-2", "run.json"),
      JSON.stringify({
        runId: "run-2",
        projectId: "tenant-1",
        projectSlug: "tenant-1",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/platform#1",
        issueState: "In Progress",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        status: "running",
        attempt: 1,
        processId: null,
        port: null,
        workingDirectory: join(runtimeRoot, "workspace", "run-2"),
        issueWorkspaceKey: "acme_platform_1",
        workspaceRuntimeDir: join(runsDir, "run-2", "workspace-runtime"),
        workflowPath: null,
        retryKind: null,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:03:00.000Z",
        startedAt: "2026-03-20T00:00:00.000Z",
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
      }) + "\n",
      "utf8"
    );

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(
      statusForIssue(reader, "acme/platform#1")
    ).resolves.toMatchObject({
      issue_identifier: "acme/platform#1",
      status: "running",
      tracked: {
        current_run_id: "missing-run",
      },
    });
  });

  it("ignores malformed unrelated run artifacts when computing cumulative tokens", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const projectDir = join(runtimeRoot, "projects", "tenant-1");
    const runsDir = join(projectDir, "runs");
    const runDir = join(runsDir, "run-1");
    const priorRunDir = join(runsDir, "run-0");
    const malformedRunDir = join(runsDir, "run-bad");
    await mkdir(runDir, { recursive: true });
    await mkdir(priorRunDir, { recursive: true });
    await mkdir(malformedRunDir, { recursive: true });

    await writeFile(
      join(projectDir, "issues.json"),
      JSON.stringify([
        {
          issueId: "issue-1",
          identifier: "acme/platform#1",
          workspaceKey: "acme_platform_1",
          completedOnce: false,
          failureRetryCount: 0,
          state: "running",
          currentRunId: "run-1",
          retryEntry: null,
          updatedAt: "2026-03-20T00:02:00.000Z",
        },
      ]) + "\n",
      "utf8"
    );
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run-1",
        projectId: "tenant-1",
        projectSlug: "tenant-1",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/platform#1",
        issueState: "In Progress",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        status: "running",
        attempt: 2,
        processId: null,
        port: null,
        workingDirectory: join(runtimeRoot, "workspace", "run-1"),
        issueWorkspaceKey: "acme_platform_1",
        workspaceRuntimeDir: join(runDir, "workspace-runtime"),
        workflowPath: null,
        retryKind: null,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:02:00.000Z",
        startedAt: "2026-03-20T00:00:00.000Z",
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 40,
          totalTokens: 160,
        },
      }) + "\n",
      "utf8"
    );
    await writeFile(
      join(priorRunDir, "run.json"),
      JSON.stringify({
        runId: "run-0",
        projectId: "tenant-1",
        projectSlug: "tenant-1",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/platform#1",
        issueState: "Done",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        status: "succeeded",
        attempt: 1,
        processId: null,
        port: null,
        workingDirectory: join(runtimeRoot, "workspace", "run-0"),
        issueWorkspaceKey: "acme_platform_1",
        workspaceRuntimeDir: join(priorRunDir, "workspace-runtime"),
        workflowPath: null,
        retryKind: null,
        createdAt: "2026-03-19T23:50:00.000Z",
        updatedAt: "2026-03-19T23:59:00.000Z",
        startedAt: "2026-03-19T23:50:00.000Z",
        completedAt: "2026-03-19T23:59:00.000Z",
        lastError: null,
        nextRetryAt: null,
        tokenUsage: {
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
        },
      }) + "\n",
      "utf8"
    );
    await writeFile(join(malformedRunDir, "run.json"), "{not-json\n", "utf8");

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(
      statusForIssue(reader, "acme/platform#1")
    ).resolves.toMatchObject({
      issue_identifier: "acme/platform#1",
      running: {
        tokens: {
          total_tokens: 160,
          cumulative_total_tokens: 260,
        },
      },
    });
  });

  it("defaults completedOnce to false for legacy persisted issue records", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const projectDir = join(runtimeRoot, "projects", "tenant-1");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "issues.json"),
      JSON.stringify([
        {
          issueId: "issue-1",
          identifier: "acme/platform#1",
          workspaceKey: "acme_platform_1",
          state: "released",
          currentRunId: null,
          retryEntry: null,
          updatedAt: "2026-03-20T00:02:00.000Z",
        },
      ]) + "\n",
      "utf8"
    );

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(reader.loadProjectIssueOrchestrations()).resolves.toEqual([
      {
        issueId: "issue-1",
        identifier: "acme/platform#1",
        workspaceKey: "acme_platform_1",
        completedOnce: false,
        failureRetryCount: 0,
        state: "released",
        currentRunId: null,
        retryEntry: null,
        updatedAt: "2026-03-20T00:02:00.000Z",
      },
    ]);
  });

  it("builds an aggregated state snapshot with completedCount", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const projectDir = join(runtimeRoot, "projects", "tenant-1");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "status.json"),
      JSON.stringify({
        projectId: "tenant-1",
        slug: "tenant-1",
        tracker: { adapter: "github-project", bindingId: "project-1" },
        lastTickAt: "2026-03-20T00:00:00.000Z",
        health: "degraded",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: "tracker unavailable",
        monitoring: {
          stalledRuns: {
            count: 1,
            runIds: ["run-1"],
            issueIdentifiers: ["acme/platform#9"],
          },
          heartbeat: {
            maxAgeMs: 900000,
            oldestLastEventAt: "2026-03-19T23:45:00.000Z",
            runningCount: 1,
          },
          retryQueue: {
            size: 2,
            nextRetryAt: "2026-03-20T00:05:00.000Z",
          },
          retryExhaustion: {
            count: 1,
            issueIdentifiers: ["acme/platform#10"],
          },
          dispatch: {
            eligibleIssues: 3,
            unscheduledEligibleIssues: 3,
            starvationConsecutiveCycles: 3,
            starvationThresholdCycles: 3,
            starved: true,
          },
          trackerApi: {
            availability: "down",
            totalCycles: 3,
            failedCycles: 3,
            consecutiveFailures: 3,
            errorRate: 1,
            lastSuccessAt: null,
            lastFailureAt: "2026-03-20T00:00:00.000Z",
          },
        },
        rateLimits: {
          remaining: 40,
          limit: 500,
        },
      }) + "\n",
      "utf8"
    );
    await writeFile(
      join(projectDir, "issues.json"),
      JSON.stringify([
        {
          issueId: "issue-1",
          identifier: "acme/platform#1",
          workspaceKey: "acme_platform_1",
          completedOnce: true,
          failureRetryCount: 0,
          state: "released",
          currentRunId: null,
          retryEntry: null,
          updatedAt: "2026-03-20T00:02:00.000Z",
        },
        {
          issueId: "issue-2",
          identifier: "acme/platform#2",
          workspaceKey: "acme_platform_2",
          completedOnce: false,
          failureRetryCount: 0,
          state: "unclaimed",
          currentRunId: null,
          retryEntry: null,
          updatedAt: "2026-03-20T00:03:00.000Z",
        },
      ]) + "\n",
      "utf8"
    );

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(reader.loadProjectState()).resolves.toMatchObject({
      projectId: "tenant-1",
      completedCount: 1,
      alerts: [
        { id: "project-health", severity: "critical" },
        { id: "retry-queue", severity: "warning" },
        { id: "stalled-runs", severity: "critical" },
        { id: "dispatch-starvation", severity: "critical" },
        { id: "retry-exhaustion", severity: "critical" },
        { id: "rate-limit", severity: "critical" },
        { id: "heartbeat-stale", severity: "warning" },
        { id: "tracker-api", severity: "critical" },
      ],
      issues: [
        { issueId: "issue-1", completedOnce: true },
        { issueId: "issue-2", completedOnce: false },
      ],
    });
  });

  it("reads recent events from large ndjson logs without scanning the entire file", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const runDir = join(runtimeRoot, "projects", "tenant-1", "runs", "run-1");
    await mkdir(runDir, { recursive: true });

    const noisyPrefix = `${"x".repeat(70_000)}\n`;
    await writeFile(join(runDir, "events.ndjson"), noisyPrefix, "utf8");
    await appendFile(
      join(runDir, "events.ndjson"),
      [
        JSON.stringify({
          at: "2026-03-20T00:01:00.000Z",
          event: "run-dispatched",
          runId: "run-1",
          issueIdentifier: "acme/platform#1",
          issueState: "Todo",
        }),
        JSON.stringify({
          at: "2026-03-20T00:02:00.000Z",
          event: "worker-error",
          runId: "run-1",
          issueIdentifier: "acme/platform#1",
          error: "worker failed",
          attempt: 1,
        }),
        "",
      ].join("\n"),
      "utf8"
    );

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(reader.loadRecentRunEvents("run-1", 2)).resolves.toEqual([
      {
        at: "2026-03-20T00:01:00.000Z",
        event: "run-dispatched",
        message: "Dispatched from Todo",
      },
      {
        at: "2026-03-20T00:02:00.000Z",
        event: "worker-error",
        message: "worker failed",
      },
    ]);
  });

  it("skips missing run records while loading persisted runs in bounded batches", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "dashboard-store-"));
    const runsDir = join(runtimeRoot, "projects", "tenant-1", "runs");
    await mkdir(join(runsDir, "run-1"), { recursive: true });
    await mkdir(join(runsDir, "run-2"), { recursive: true });
    await writeFile(
      join(runsDir, "run-1", "run.json"),
      JSON.stringify({
        runId: "run-1",
        projectId: "tenant-1",
        projectSlug: "tenant-1",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/platform#1",
        issueState: "Todo",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        status: "running",
        attempt: 1,
        processId: null,
        port: null,
        workingDirectory: join(runtimeRoot, "workspace", "run-1"),
        issueWorkspaceKey: "acme_platform_1",
        workspaceRuntimeDir: join(runsDir, "run-1", "workspace-runtime"),
        workflowPath: null,
        retryKind: null,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:03:00.000Z",
        startedAt: "2026-03-20T00:00:00.000Z",
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
      }) + "\n",
      "utf8"
    );

    const reader = new DashboardFsReader(runtimeRoot, "tenant-1");

    await expect(reader.loadAllRuns()).resolves.toMatchObject([
      {
        runId: "run-1",
        issueIdentifier: "acme/platform#1",
      },
    ]);
  });
});

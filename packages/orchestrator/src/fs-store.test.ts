import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { chdir } from "node:process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { OrchestratorFsStore } from "./fs-store.js";

describe("OrchestratorFsStore.loadRecentRunEvents", () => {
  it("uses a project-scoped runtime layout", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    expect(store.projectDir("project-1")).toBe(
      join(runtimeRoot, "projects", "project-1")
    );
    expect(store.runDir("run-1", "project-1")).toBe(
      join(runtimeRoot, "projects", "project-1", "runs", "run-1")
    );
    expect(store.issueWorkspaceDir("project-1", "acme_repo_1")).toBe(
      join(runtimeRoot, "projects", "project-1", "acme_repo_1")
    );
  });

  it("creates project directories with owner-only permissions", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    const previousUmask = process.umask(0);
    try {
      await store.saveProjectConfig({
        projectId: "project-1",
        slug: "project-1",
        workspaceDir: "/tmp/workspaces/project-1",
        repository: {
          owner: "acme",
          name: "repo",
          cloneUrl: "https://github.com/acme/repo.git",
        },
        tracker: {
          adapter: "file",
          bindingId: "file-project-1",
        },
      });

      const stats = await stat(store.projectDir("project-1"));

      expect(stats.mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("defaults legacy project configs to repository workflows and cloning", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    const projectDir = store.projectDir("project-1");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.json"),
      JSON.stringify({
        projectId: "project-1",
        slug: "project-1",
        workspaceDir: "/tmp/workspaces/project-1",
        repository: { owner: "acme", name: "repo" },
        tracker: { adapter: "file", bindingId: "file-project-1" },
      }),
      "utf8"
    );

    await expect(store.loadProjectConfig("project-1")).resolves.toEqual(
      expect.objectContaining({
        workflowSource: { type: "repo" },
        populateStrategy: "clone",
      })
    );
  });

  it("rejects legacy repo configs that use workspaceDir as the checkout", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    const projectDir = store.projectDir("project-1");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.json"),
      JSON.stringify({
        projectId: "project-1",
        slug: "project-1",
        workspaceDir: "/repos/acme",
        repository: { owner: "acme", name: "repo", path: "/repos/acme" },
        tracker: { adapter: "file", bindingId: "file-project-1" },
      }),
      "utf8"
    );

    await expect(store.loadProjectConfig("project-1")).rejects.toThrow(
      "legacy repo-embedded path metadata"
    );
  });

  it("round-trips standalone project configuration", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    const config = {
      projectId: "project-1",
      slug: "project-1",
      workspaceDir: "/tmp/workspaces/project-1",
      repository: { owner: "acme", name: "repo" },
      tracker: { adapter: "file" as const, bindingId: "file-project-1" },
      workflowSource: {
        type: "external" as const,
        path: "/projects/project-1/WORKFLOW.md",
      },
      populateStrategy: "worktree-cache" as const,
      projectDir: "/projects/project-1",
    };

    await store.saveProjectConfig(config);

    await expect(store.loadProjectConfig("project-1")).resolves.toEqual(config);
  });

  it.each([
    [{ type: "external" }],
    [{ type: "external", path: "projects/project-1/WORKFLOW.md" }],
  ])("rejects invalid external workflow source %j", async (workflowSource) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await expect(
      store.saveProjectConfig({
        projectId: "project-1",
        slug: "project-1",
        workspaceDir: "/tmp/workspaces/project-1",
        repository: { owner: "acme", name: "repo" },
        tracker: { adapter: "file", bindingId: "file-project-1" },
        workflowSource: workflowSource as never,
      })
    ).rejects.toThrow("external workflow source");
  });

  it.each([
    ["workflow source type", { type: "externel" }],
    ["populate strategy", "copy"],
  ])("rejects an unsupported %s", async (_label, value) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await expect(
      store.saveProjectConfig({
        projectId: "project-1",
        slug: "project-1",
        workspaceDir: "/tmp/workspaces/project-1",
        repository: { owner: "acme", name: "repo" },
        tracker: { adapter: "file", bindingId: "file-project-1" },
        ...(typeof value === "string"
          ? { populateStrategy: value as never }
          : { workflowSource: value as never }),
      })
    ).rejects.toThrow("project-1");
  });

  it("loads only issue workspace directories from the project runtime root", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    const projectDir = store.projectDir("project-1");

    await mkdir(join(projectDir, "runs"), { recursive: true });
    await mkdir(join(projectDir, "cache"), { recursive: true });
    await mkdir(join(projectDir, ".lock"), { recursive: true });
    await writeFile(join(projectDir, "status.json"), "{}", "utf8");
    await writeFile(
      join(projectDir, "runs", "workspace.json"),
      JSON.stringify({
        workspaceKey: "runs",
      }),
      "utf8"
    );
    await store.saveIssueWorkspace({
      workspaceKey: "acme_repo_1",
      projectId: "project-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/repo#1",
      workspacePath: join(projectDir, "acme_repo_1"),
      repositoryPath: join(projectDir, "acme_repo_1", "repository"),
      status: "active",
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
      lastError: null,
    });

    await expect(store.loadIssueWorkspaces("project-1")).resolves.toEqual([
      expect.objectContaining({
        workspaceKey: "acme_repo_1",
      }),
    ]);
  });

  it("falls back to legacy flat workspaces on direct loads", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    const workspaceKey = "acme_repo_1";
    await mkdir(join(runtimeRoot, workspaceKey), { recursive: true });
    await writeFile(
      join(runtimeRoot, workspaceKey, "workspace.json"),
      JSON.stringify({
        workspaceKey,
        projectId: "project-1",
        adapter: "github-project",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/repo#1",
        workspacePath: join(runtimeRoot, workspaceKey),
        repositoryPath: join(runtimeRoot, workspaceKey, "repository"),
        status: "active",
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
        lastError: null,
      }),
      "utf8"
    );

    await expect(
      store.loadIssueWorkspace("project-1", workspaceKey)
    ).resolves.toEqual(
      expect.objectContaining({
        workspaceKey,
        projectId: "project-1",
      })
    );
  });

  it("requires projectId for new project status writes", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await expect(store.saveProjectStatus({} as never)).rejects.toThrow(
      "Project status writes require a projectId."
    );
  });

  it("returns the most recent formatted events in order", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await store.appendRunEvent("run-1", {
      at: "2026-03-16T00:00:00.000Z",
      event: "run-dispatched",
      projectId: "project-1",
      issueIdentifier: "acme/repo#1",
      issueState: "Todo",
    });
    await store.appendRunEvent("run-1", {
      at: "2026-03-16T00:01:00.000Z",
      event: "worker-error",
      runId: "run-1",
      issueIdentifier: "acme/repo#1",
      error: "worker failed",
      attempt: 1,
    });

    const events = await store.loadRecentRunEvents("run-1", 1);

    expect(events).toEqual([
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "worker-error",
        message: "worker failed",
      },
    ]);
  });

  it("returns an empty array when the event log does not exist", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await expect(store.loadRecentRunEvents("missing-run")).resolves.toEqual([]);
  });

  it("skips corrupted trailing lines and returns the latest valid events", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    const path = join(store.runDir("run-1", "project-1"), "events.ndjson");
    await mkdir(store.runDir("run-1", "project-1"), { recursive: true });

    await appendFile(
      path,
      [
        JSON.stringify({
          at: "2026-03-16T00:00:00.000Z",
          event: "run-dispatched",
          projectId: "project-1",
          issueIdentifier: "acme/repo#1",
          issueState: "Todo",
        }),
        '{"bad":',
        JSON.stringify({
          at: "2026-03-16T00:01:00.000Z",
          event: "worker-error",
          runId: "run-1",
          issueIdentifier: "acme/repo#1",
          error: "worker failed",
          attempt: 1,
        }),
        "",
      ].join("\n"),
      "utf8"
    );

    await expect(store.loadRecentRunEvents("run-1", 2)).resolves.toEqual([
      {
        at: "2026-03-16T00:00:00.000Z",
        event: "run-dispatched",
        message: "Dispatched from Todo",
      },
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "worker-error",
        message: "worker failed",
      },
    ]);
  });

  it("writes events to the provided project run directory before run.json exists", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await store.appendRunEvent("run-1", {
      at: "2026-03-16T00:01:00.000Z",
      event: "hook-failed",
      projectId: "project-1",
      hook: "after_create",
      error: "hook failed",
    });

    await expect(
      store.loadRecentRunEvents("run-1", 1, "project-1")
    ).resolves.toEqual([
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "hook-failed",
        message: "hook failed",
      },
    ]);
  });

  it("redacts tokens from run.json and events.ndjson before persistence", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await store.saveRun({
      runId: "run-1",
      projectId: "project-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-123",
      issueTitle: "Linear issue",
      issueState: "Todo",
      issueSubjectId: "issue-1",
      repository: {
        owner: "acme",
        name: "repo",
        cloneUrl: "https://github.com/acme/repo.git",
        url: "https://github.com/acme/repo",
      },
      workspaceKey: "ENG-123",
      workspacePath: "/tmp/workspace",
      repositoryPath: "/tmp/workspace/repository",
      status: "active",
      attempt: 1,
      maxAttempts: 1,
      processId: null,
      sessionId: null,
      startedAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      lastWorkerLog: null,
      lastTurnSummary: null,
      tokenUsage: undefined,
      linear: {
        LINEAR_API_KEY: "lin_secret",
      },
    } as never);

    await store.appendRunEvent("run-1", {
      at: "2026-05-14T00:00:00.000Z",
      event: "worker-error",
      projectId: "project-1",
      runId: "run-1",
      issueIdentifier: "ENG-123",
      error: "worker failed",
      attempt: 1,
      headers: {
        authorization: "Bearer lin_secret",
      },
    } as never);

    const runJson = await readFile(
      join(store.runDir("run-1", "project-1"), "run.json"),
      "utf8"
    );
    const eventsNdjson = await readFile(
      join(store.runDir("run-1", "project-1"), "events.ndjson"),
      "utf8"
    );

    expect(runJson).not.toContain("lin_secret");
    expect(eventsNdjson).not.toContain("lin_secret");
    expect(runJson).toContain("[REDACTED]");
    expect(eventsNdjson).toContain("[REDACTED]");
  });

  it("discovers project runs when project ids need path encoding", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await store.saveRun({
      runId: "run-1",
      projectId: "tenant:one",
      issueId: "issue-1",
      issueIdentifier: "ENG-123",
      issueTitle: "Linear issue",
      issueState: "Todo",
      issueSubjectId: "issue-1",
      repository: {
        owner: "acme",
        name: "repo",
        cloneUrl: "https://github.com/acme/repo.git",
        url: "https://github.com/acme/repo",
      },
      workspaceKey: "ENG-123",
      workspacePath: "/tmp/workspace",
      repositoryPath: "/tmp/workspace/repository",
      status: "active",
      attempt: 1,
      maxAttempts: 1,
      processId: null,
      sessionId: null,
      startedAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      lastWorkerLog: null,
      lastTurnSummary: null,
      tokenUsage: undefined,
    } as never);

    await expect(store.loadAllRuns()).resolves.toEqual([
      expect.objectContaining({
        runId: "run-1",
        projectId: "tenant:one",
      }),
    ]);
    await expect(store.loadRun("run-1")).resolves.toEqual(
      expect.objectContaining({
        runId: "run-1",
        projectId: "tenant:one",
      })
    );
  });

  it("mirrors events to an external directory when configured", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const eventsMirrorRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-events-")
    );
    const store = new OrchestratorFsStore(runtimeRoot, {
      eventsMirrorRoot,
    });

    await store.appendRunEvent("run-1", {
      at: "2026-03-16T00:01:00.000Z",
      event: "hook-failed",
      projectId: "project-1",
      hook: "after_create",
      error: "hook failed",
    });

    await expect(
      readFile(
        join(
          eventsMirrorRoot,
          "projects",
          "project-1",
          "runs",
          "run-1",
          "events.ndjson"
        ),
        "utf8"
      )
    ).resolves.toContain('"event":"hook-failed"');
  });

  it("creates primary and mirrored event logs with owner-writable defaults", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const eventsMirrorRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-events-")
    );
    const store = new OrchestratorFsStore(runtimeRoot, {
      eventsMirrorRoot,
    });

    const previousUmask = process.umask(0);

    try {
      await store.appendRunEvent("run-1", {
        at: "2026-03-16T00:01:00.000Z",
        event: "hook-failed",
        projectId: "project-1",
        hook: "after_create",
        error: "hook failed",
      });

      const primaryStats = await stat(
        join(
          runtimeRoot,
          "projects",
          "project-1",
          "runs",
          "run-1",
          "events.ndjson"
        )
      );
      const mirroredStats = await stat(
        join(
          eventsMirrorRoot,
          "projects",
          "project-1",
          "runs",
          "run-1",
          "events.ndjson"
        )
      );

      expect(primaryStats.mode & 0o644).toBe(0o644);
      expect(mirroredStats.mode & 0o644).toBe(0o644);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("mirrors events when the runtime root is configured as a relative path", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "orchestrator-cwd-"));
    const previousCwd = process.cwd();
    const eventsMirrorRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-events-")
    );

    chdir(workspaceRoot);
    try {
      const store = new OrchestratorFsStore(".runtime", {
        eventsMirrorRoot,
      });

      await store.appendRunEvent("run-1", {
        at: "2026-03-16T00:01:00.000Z",
        event: "hook-failed",
        projectId: "project-1",
        hook: "after_create",
        error: "hook failed",
      });

      await expect(
        readFile(
          join(
            eventsMirrorRoot,
            "projects",
            "project-1",
            "runs",
            "run-1",
            "events.ndjson"
          ),
          "utf8"
        )
      ).resolves.toContain('"event":"hook-failed"');
    } finally {
      chdir(previousCwd);
    }
  });

  it("does not fail the primary write when the mirror path is unavailable", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const eventsMirrorRoot = join(runtimeRoot, "mirror-file");
    const store = new OrchestratorFsStore(runtimeRoot, {
      eventsMirrorRoot,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await appendFile(eventsMirrorRoot, "not-a-directory", "utf8");

    try {
      await expect(
        store.appendRunEvent("run-1", {
          at: "2026-03-16T00:01:00.000Z",
          event: "hook-failed",
          projectId: "project-1",
          hook: "after_create",
          error: "hook failed",
        })
      ).resolves.toBeUndefined();

      await expect(
        readFile(
          join(
            runtimeRoot,
            "projects",
            "project-1",
            "runs",
            "run-1",
            "events.ndjson"
          ),
          "utf8"
        )
      ).resolves.toContain('"event":"hook-failed"');
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("OrchestratorFsStore.loadProjectIssueOrchestrations", () => {
  it("defaults retry metadata for legacy persisted issue records", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    await mkdir(store.projectDir("project-1"), { recursive: true });
    await writeFile(
      join(store.projectDir("project-1"), "issues.json"),
      JSON.stringify([
        {
          issueId: "issue-1",
          identifier: "acme/repo#1",
          workspaceKey: "acme_repo_1",
          state: "released",
          currentRunId: null,
          retryEntry: null,
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      ]) + "\n",
      "utf8"
    );

    await expect(
      store.loadProjectIssueOrchestrations("project-1")
    ).resolves.toEqual([
      {
        issueId: "issue-1",
        identifier: "acme/repo#1",
        workspaceKey: "acme_repo_1",
        completedOnce: false,
        failureRetryCount: 0,
        failureRetrySuppressedState: null,
        state: "released",
        currentRunId: null,
        retryEntry: null,
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
    ]);
  });

  it("migrates legacy flat leases when scoped issues are absent", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    await writeFile(
      join(runtimeRoot, "leases.json"),
      JSON.stringify([
        {
          issueId: "issue-1",
          issueIdentifier: "acme/repo#1",
          runId: "run-1",
          status: "active",
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      ]) + "\n",
      "utf8"
    );

    await expect(
      store.loadProjectIssueOrchestrations("project-1")
    ).resolves.toEqual([
      expect.objectContaining({
        issueId: "issue-1",
        identifier: "acme/repo#1",
        state: "claimed",
        currentRunId: "run-1",
      }),
    ]);
    await expect(
      readFile(join(store.projectDir("project-1"), "issues.json"), "utf8")
    ).resolves.toContain("acme/repo#1");
  });
});

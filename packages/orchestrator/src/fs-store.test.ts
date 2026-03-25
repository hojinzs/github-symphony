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
  it("defaults completedOnce to false for legacy persisted issue records", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    await mkdir(join(runtimeRoot, "projects", "project-1"), {
      recursive: true,
    });
    await writeFile(
      join(runtimeRoot, "projects", "project-1", "issues.json"),
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
        state: "released",
        currentRunId: null,
        retryEntry: null,
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
    ]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileTrackerAdapter } from "./file-tracker-adapter.js";
import type {
  OrchestratorProjectConfig,
  OrchestratorRunRecord,
  TrackedIssue,
} from "@gh-symphony/core";

function makeProject(issuesPath: string): OrchestratorProjectConfig {
  return {
    projectId: "test-project",
    slug: "test-project",
    workspaceDir: "/tmp/test",
    repositories: [
      { owner: "test-owner", name: "test-repo", cloneUrl: "/tmp/test-repo" },
    ],
    tracker: {
      adapter: "file",
      bindingId: "e2e-test",
      settings: { issuesPath },
    },
  };
}

const sampleIssue: TrackedIssue = {
  id: "issue-1",
  identifier: "test-owner/test-repo#1",
  number: 1,
  title: "Test issue",
  description: "A test issue for E2E",
  priority: null,
  state: "Ready",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: "2026-03-17T00:00:00Z",
  updatedAt: "2026-03-17T00:00:00Z",
  repository: {
    owner: "test-owner",
    name: "test-repo",
    cloneUrl: "/tmp/test-repo",
  },
  tracker: {
    adapter: "file",
    bindingId: "e2e-test",
    itemId: "issue-1",
  },
  metadata: {},
};

describe("fileTrackerAdapter", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tracker-file-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("listIssues", () => {
    it("reads issues from a JSON file", async () => {
      const issuesPath = join(testDir, "issues.json");
      await writeFile(issuesPath, JSON.stringify([sampleIssue]));

      const project = makeProject(issuesPath);
      const issues = await fileTrackerAdapter.listIssues(project);

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("issue-1");
      expect(issues[0].state).toBe("Ready");
    });

    it("returns empty array when file does not exist", async () => {
      const project = makeProject(join(testDir, "nonexistent.json"));
      const issues = await fileTrackerAdapter.listIssues(project);

      expect(issues).toEqual([]);
    });

    it("filters out entries with invalid shape", async () => {
      const issuesPath = join(testDir, "mixed.json");
      const invalidEntry = { title: "no id or state" };
      await writeFile(
        issuesPath,
        JSON.stringify([sampleIssue, invalidEntry, sampleIssue])
      );

      const project = makeProject(issuesPath);
      const issues = await fileTrackerAdapter.listIssues(project);

      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("issue-1");
      expect(issues[1].id).toBe("issue-1");
    });

    it("returns empty array when file contains truncated JSON", async () => {
      const issuesPath = join(testDir, "truncated.json");
      await writeFile(issuesPath, '[{"id":');

      const project = makeProject(issuesPath);
      const issues = await fileTrackerAdapter.listIssues(project);

      expect(issues).toEqual([]);
    });

    it("throws when file contains non-array JSON", async () => {
      const issuesPath = join(testDir, "bad.json");
      await writeFile(issuesPath, JSON.stringify({ not: "an array" }));

      const project = makeProject(issuesPath);
      await expect(fileTrackerAdapter.listIssues(project)).rejects.toThrow(
        "Expected an array"
      );
    });

    it("throws when issuesPath setting is missing", async () => {
      const project: OrchestratorProjectConfig = {
        projectId: "test",
        slug: "test",
        workspaceDir: "/tmp",
        repositories: [],
        tracker: {
          adapter: "file",
          bindingId: "e2e-test",
          settings: {},
        },
      };

      await expect(fileTrackerAdapter.listIssues(project)).rejects.toThrow(
        'requires the "issuesPath" setting'
      );
    });
  });

  describe("listIssuesByStates", () => {
    it("filters issues to the requested workflow states", async () => {
      const issuesPath = join(testDir, "issues.json");
      await writeFile(
        issuesPath,
        JSON.stringify([
          sampleIssue,
          {
            ...sampleIssue,
            id: "issue-2",
            identifier: "test-owner/test-repo#2",
            number: 2,
            state: "Done",
          },
        ])
      );

      const project = makeProject(issuesPath);
      const issues = await fileTrackerAdapter.listIssuesByStates(project, ["done"]);

      expect(issues).toHaveLength(1);
      expect(issues[0]?.id).toBe("issue-2");
      expect(issues[0]?.state).toBe("Done");
    });
  });

  describe("buildWorkerEnvironment", () => {
    it("returns SYMPHONY_FILE_TRACKER flag", () => {
      const project = makeProject("/tmp/issues.json");
      const env = fileTrackerAdapter.buildWorkerEnvironment(
        project,
        sampleIssue
      );

      expect(env).toEqual({ SYMPHONY_FILE_TRACKER: "true" });
    });
  });

  describe("reviveIssue", () => {
    it("reconstructs a TrackedIssue from a run record", () => {
      const project = makeProject("/tmp/issues.json");
      const run = {
        runId: "run-1",
        projectId: "test-project",
        projectSlug: "test-project",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "test-owner/test-repo#1",
        issueTitle: "Recovered issue title",
        issueState: "Ready",
        repository: {
          owner: "test-owner",
          name: "test-repo",
          cloneUrl: "/tmp/test-repo",
        },
        status: "succeeded" as const,
        attempt: 1,
        processId: null,
        port: null,
        workingDirectory: "/tmp",
        issueWorkspaceKey: null,
        workspaceRuntimeDir: "/tmp",
        workflowPath: null,
        retryKind: null,
        createdAt: "2026-03-17T00:00:00Z",
        updatedAt: "2026-03-17T00:00:00Z",
        startedAt: null,
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
      } satisfies OrchestratorRunRecord;

      const issue = fileTrackerAdapter.reviveIssue(project, run);

      expect(issue.id).toBe("issue-1");
      expect(issue.identifier).toBe("test-owner/test-repo#1");
      expect(issue.number).toBe(1);
      expect(issue.title).toBe("Recovered issue title");
      expect(issue.tracker.adapter).toBe("file");
      expect(issue.tracker.bindingId).toBe("e2e-test");
    });

    it("falls back to issueIdentifier when issueTitle is absent", () => {
      const project = makeProject("/tmp/issues.json");
      const run = {
        runId: "run-1",
        projectId: "test-project",
        projectSlug: "test-project",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "test-owner/test-repo#1",
        issueState: "Ready",
        repository: {
          owner: "test-owner",
          name: "test-repo",
          cloneUrl: "/tmp/test-repo",
        },
        status: "succeeded" as const,
        attempt: 1,
        processId: null,
        port: null,
        workingDirectory: "/tmp",
        issueWorkspaceKey: null,
        workspaceRuntimeDir: "/tmp",
        workflowPath: null,
        retryKind: null,
        createdAt: "2026-03-17T00:00:00Z",
        updatedAt: "2026-03-17T00:00:00Z",
        startedAt: null,
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
      } satisfies OrchestratorRunRecord;

      const issue = fileTrackerAdapter.reviveIssue(project, run);

      expect(issue.title).toBe("test-owner/test-repo#1");
    });
  });
});

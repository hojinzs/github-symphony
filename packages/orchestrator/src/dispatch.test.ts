import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorService, sortCandidatesForDispatch } from "./service.js";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
  TrackedIssue,
  TrackedPullRequestContext,
  IssueWorkspaceRecord,
} from "@gh-symphony/core";
import {
  deriveIssueWorkspaceKey,
  resolveIssueWorkspaceDirectory,
} from "@gh-symphony/core";
import { OrchestratorFsStore } from "./fs-store.js";
import * as trackerAdapters from "./tracker-adapters.js";

function makeIssue(
  overrides: Partial<TrackedIssue> & { identifier: string }
): TrackedIssue {
  const metadata = overrides.metadata ?? {};
  return {
    id: overrides.identifier,
    identifier: overrides.identifier,
    number: 1,
    title: "Test",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    dispatchable: true,
    assigneeId: null,
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner: "dispatch-acme",
      name: "repo",
      cloneUrl: "https://github.com/acme/repo.git",
    },
    tracker: {
      adapter: "github-project",
      bindingId: "proj-1",
      itemId: "item-1",
    },
    metadata,
    ...overrides,
    contentType: overrides.contentType ?? metadata.contentType,
    linkedPullRequests:
      overrides.linkedPullRequests ?? metadata.linkedPullRequests,
    pullRequest: overrides.pullRequest ?? metadata.pullRequest,
  };
}

function makeRun(
  overrides: Partial<OrchestratorRunRecord> & { runId: string; issueId: string }
): OrchestratorRunRecord {
  return {
    runId: overrides.runId,
    projectId: "tenant-1",
    projectSlug: "tenant-1",
    issueId: overrides.issueId,
    issueSubjectId: overrides.issueId,
    issueIdentifier: "acme/repo#1",
    issueTitle: "Test",
    issueState: "Todo",
    repository: {
      owner: "dispatch-acme",
      name: "repo",
      cloneUrl: "https://github.com/acme/repo.git",
    },
    status: "running",
    attempt: 1,
    processId: null,
    port: null,
    workingDirectory: "/tmp/work",
    issueWorkspaceKey: "acme-repo-1",
    workspaceRuntimeDir: "/tmp/runtime",
    workflowPath: null,
    retryKind: null,
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    startedAt: "2026-03-09T00:00:00.000Z",
    completedAt: null,
    lastError: null,
    nextRetryAt: null,
    ...overrides,
  };
}

function makeIssueWorkspace(
  overrides: Partial<IssueWorkspaceRecord> & { workspaceKey: string }
): IssueWorkspaceRecord {
  return {
    workspaceKey: overrides.workspaceKey,
    projectId: "tenant-1",
    adapter: "github-project",
    issueSubjectId: "issue-1",
    issueIdentifier: "acme/repo#1",
    workspacePath: "/tmp/workspace",
    repositoryPath: "/tmp/work",
    status: "active",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function makePullRequestContext(
  repository: { owner: string; name: string; cloneUrl: string; path: string },
  number: number,
  branchName = `feature/pr-${number}`
): TrackedPullRequestContext {
  return {
    id: `pr-${number}`,
    number,
    identifier: `${repository.owner}/${repository.name}#${number}`,
    url: `https://github.com/${repository.owner}/${repository.name}/pull/${number}`,
    state: "OPEN",
    headRefName: branchName,
    repository: {
      owner: repository.owner,
      name: repository.name,
      url: `https://github.com/${repository.owner}/${repository.name}`,
      cloneUrl: repository.cloneUrl,
    },
    headRepository: {
      owner: repository.owner,
      name: repository.name,
      url: `https://github.com/${repository.owner}/${repository.name}`,
      cloneUrl: repository.cloneUrl,
    },
  };
}

function createPullRequestBranch(
  repository: { path: string },
  branchName: string
): void {
  execSync(`git -C ${shell(repository.path)} branch ${shell(branchName)}`, {
    stdio: "ignore",
  });
}

describe("sortCandidatesForDispatch", () => {
  it("sorts by priority ascending", () => {
    const sorted = sortCandidatesForDispatch([
      makeIssue({ identifier: "acme/repo#3", priority: 3 }),
      makeIssue({ identifier: "acme/repo#1", priority: 1 }),
      makeIssue({ identifier: "acme/repo#2", priority: 2 }),
    ]);

    expect(sorted.map((issue) => issue.priority)).toEqual([1, 2, 3]);
  });

  it("puts null priority last", () => {
    const sorted = sortCandidatesForDispatch([
      makeIssue({ identifier: "acme/repo#1", priority: null }),
      makeIssue({ identifier: "acme/repo#2", priority: 1 }),
      makeIssue({ identifier: "acme/repo#3", priority: null }),
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual([
      "acme/repo#2",
      "acme/repo#1",
      "acme/repo#3",
    ]);
  });

  // #725 documents this repository-local numeric priority mapping.
  it("orders explicit tracker priority values per ADR 2026-08-28 before null priorities", () => {
    const sorted = sortCandidatesForDispatch([
      makeIssue({ identifier: "acme/repo#null", priority: null }),
      makeIssue({ identifier: "acme/repo#high", priority: 1 }),
      makeIssue({ identifier: "acme/repo#urgent", priority: 0 }),
      makeIssue({ identifier: "acme/repo#low", priority: 3 }),
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual([
      "acme/repo#urgent",
      "acme/repo#high",
      "acme/repo#low",
      "acme/repo#null",
    ]);
  });

  it("breaks ties by parsed RFC 3339 createdAt instant, with invalid timestamps last", () => {
    const sorted = sortCandidatesForDispatch([
      makeIssue({
        identifier: "acme/repo#null",
        priority: 1,
        createdAt: null,
      }),
      makeIssue({
        identifier: "acme/repo#invalid",
        priority: 1,
        createdAt: "not-a-date",
      }),
      makeIssue({
        identifier: "acme/repo#local",
        priority: 1,
        // Offset-free timestamps are not RFC 3339 instants and must not be
        // interpreted using the host timezone. They join the null bucket.
        createdAt: "2026-03-08T00:00:00",
      }),
      makeIssue({
        identifier: "acme/repo#later",
        priority: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
      }),
      makeIssue({
        identifier: "acme/repo#older",
        priority: 1,
        // This is 2026-03-07T23:30:00.000Z, despite sorting after the
        // `Z` timestamp lexicographically.
        createdAt: "2026-03-08T00:30:00.000+01:00",
      }),
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual([
      "acme/repo#older",
      "acme/repo#later",
      "acme/repo#invalid",
      "acme/repo#local",
      "acme/repo#null",
    ]);
  });

  it("breaks double ties by identifier", () => {
    const createdAt = "2026-03-08T00:00:00.000Z";
    const sorted = sortCandidatesForDispatch([
      makeIssue({ identifier: "acme/repo#b", priority: 1, createdAt }),
      makeIssue({ identifier: "acme/repo#a", priority: 1, createdAt }),
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual([
      "acme/repo#a",
      "acme/repo#b",
    ]);
  });

  it("handles all-null priorities gracefully", () => {
    const sorted = sortCandidatesForDispatch([
      makeIssue({
        identifier: "acme/repo#c",
        priority: null,
        createdAt: null,
      }),
      makeIssue({
        identifier: "acme/repo#b",
        priority: null,
        createdAt: "2026-03-09T00:00:00.000Z",
      }),
      makeIssue({
        identifier: "acme/repo#a",
        priority: null,
        createdAt: "2026-03-08T00:00:00.000Z",
      }),
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual([
      "acme/repo#a",
      "acme/repo#b",
      "acme/repo#c",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(sortCandidatesForDispatch([])).toEqual([]);
  });
});

describe("per-state concurrency limits", () => {
  const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_GRAPHQL_TOKEN;
    } else {
      process.env.GITHUB_GRAPHQL_TOKEN = originalToken;
    }
  });

  it("dispatches only one issue in Todo state when Todo limit is 1", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-dispatch-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform",
      {
        maxConcurrentByState: {
          Todo: 1,
        },
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5101, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          createTrackerResponse(repository, ["Todo", "Todo", "Todo"])
        ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("applies a trimmed, case-insensitive state limit to dispatch", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-dispatch-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform",
      {
        maxConcurrentByState: {
          '" todo "': 1,
        },
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5103, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          createTrackerResponse(repository, ["Todo", "Todo", "Todo"])
        ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("dispatches all three issues in Todo state when Todo limit is 3", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-dispatch-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform",
      {
        maxConcurrentByState: {
          Todo: 3,
        },
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5102, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          createTrackerResponse(repository, ["Todo", "Todo", "Todo"])
        ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(3);
    expect(spawnImpl).toHaveBeenCalledTimes(3);
  });
});

describe("blocker eligibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not dispatch issues the tracker marks non-dispatchable", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-dispatchable-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const issue = makeIssue({
      identifier: "dispatch-acme/platform#1",
      state: "Todo",
      dispatchable: false,
      dispatchReason: "assigned to another agent",
      repository,
    });
    const adapter: OrchestratorTrackerAdapter = {
      listIssues: vi.fn().mockResolvedValue([issue]),
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([issue]),
      buildWorkerEnvironment: () => ({ GITHUB_PROJECT_ID: "project-123" }),
      reviveIssue: vi.fn(),
    };
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(adapter);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5200, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    await expect(service.runOnce()).resolves.toMatchObject({
      summary: expect.objectContaining({ dispatched: 0 }),
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("dispatches unblocked issue and skips issue blocked by non-terminal blocker", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-blocker-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const issueA = makeIssue({
      id: "issue-1",
      identifier: "dispatch-acme/platform#1",
      number: 1,
      state: "Todo",
      repository: {
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl,
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-1",
      },
    });
    const issueB = makeIssue({
      id: "issue-2",
      identifier: "dispatch-acme/platform#2",
      number: 2,
      state: "Todo",
      dispatchable: false,
      dispatchReason:
        "Blocked by unresolved GitHub issue: dispatch-acme/platform#1.",
      blockedBy: [
        {
          id: "issue-1",
          identifier: "dispatch-acme/platform#1",
          state: "Todo",
        },
      ],
      repository: {
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl,
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-2",
      },
    });

    const listIssues = vi.fn().mockResolvedValue([issueA, issueB]);
    const adapter: OrchestratorTrackerAdapter = {
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: () => ({ GITHUB_PROJECT_ID: "project-123" }),
      reviveIssue: (
        _tenant: OrchestratorProjectConfig,
        run: OrchestratorRunRecord
      ) =>
        makeIssue({
          id: run.issueId,
          identifier: run.issueIdentifier,
          state: run.issueState,
          repository: {
            owner: repository.owner,
            name: repository.name,
            cloneUrl: repository.cloneUrl,
          },
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            itemId: run.issueId,
          },
        }),
    };
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(adapter);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5201, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-1",
        }),
      })
    );
  });

  it("dispatches blocked issue when blocker is terminal", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-blocker-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const issueA = makeIssue({
      id: "issue-1",
      identifier: "dispatch-acme/platform#1",
      number: 1,
      state: "Done",
      repository: {
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl,
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-1",
      },
    });
    const issueB = makeIssue({
      id: "issue-2",
      identifier: "dispatch-acme/platform#2",
      number: 2,
      state: "Todo",
      blockedBy: [
        {
          id: "issue-1",
          identifier: "dispatch-acme/platform#1",
          state: "Done",
        },
      ],
      repository: {
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl,
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-2",
      },
    });

    const listIssues = vi.fn().mockResolvedValue([issueA, issueB]);
    const adapter: OrchestratorTrackerAdapter = {
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: () => ({ GITHUB_PROJECT_ID: "project-123" }),
      reviveIssue: (
        _tenant: OrchestratorProjectConfig,
        run: OrchestratorRunRecord
      ) =>
        makeIssue({
          id: run.issueId,
          identifier: run.issueIdentifier,
          state: run.issueState,
          repository: {
            owner: repository.owner,
            name: repository.name,
            cloneUrl: repository.cloneUrl,
          },
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            itemId: run.issueId,
          },
        }),
    };
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(adapter);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5202, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-2",
        }),
      })
    );
  });

  it("dispatches blocked issue when cross-project blocker is terminal", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-blocker-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const issue = makeIssue({
      id: "issue-2",
      identifier: "dispatch-acme/platform#2",
      number: 2,
      state: "Todo",
      blockedBy: [
        {
          id: "issue-99",
          identifier: "other/repo#99",
          state: "Done",
        },
      ],
      repository: {
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl,
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-2",
      },
    });

    const listIssues = vi.fn().mockResolvedValue([issue]);
    const adapter: OrchestratorTrackerAdapter = {
      listIssues,
      listIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      buildWorkerEnvironment: () => ({ GITHUB_PROJECT_ID: "project-123" }),
      reviveIssue: (
        _tenant: OrchestratorProjectConfig,
        run: OrchestratorRunRecord
      ) =>
        makeIssue({
          id: run.issueId,
          identifier: run.issueIdentifier,
          state: run.issueState,
          repository: {
            owner: repository.owner,
            name: repository.name,
            cloneUrl: repository.cloneUrl,
          },
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            itemId: run.issueId,
          },
        }),
    };
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(adapter);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5203, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-2",
        }),
      })
    );
    const runs = await store.loadAllRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.issueTitle).toBe("Test");
  });
});

describe("routability reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops an active run that loses a required label without cleaning its workspace", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-routability-reconciliation-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform",
      { requiredLabels: ["agent"] }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const issue = makeIssue({
      id: "issue-routable-1",
      identifier: "dispatch-acme/platform#1",
      state: "Todo",
      labels: [],
      repository,
    });
    const workspaceKey = deriveIssueWorkspaceKey(
      { adapter: "github-project", issueSubjectId: issue.id },
      issue.identifier
    );
    const workspacePath = resolveIssueWorkspaceDirectory(
      projectConfig.workspaceDir,
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");
    const sentinelPath = join(repositoryPath, "preserve.txt");
    await mkdir(repositoryPath, { recursive: true });
    execSync(`git -C ${shell(repositoryPath)} init`, { stdio: "ignore" });
    execSync(
      `git -C ${shell(repositoryPath)} config user.email tester@example.com`
    );
    execSync(`git -C ${shell(repositoryPath)} config user.name tester`);
    await writeFile(join(repositoryPath, "tracked.txt"), "tracked", "utf8");
    execSync(`git -C ${shell(repositoryPath)} add tracked.txt`, {
      stdio: "ignore",
    });
    execSync(`git -C ${shell(repositoryPath)} commit -m init`, {
      stdio: "ignore",
    });
    await writeFile(sentinelPath, "do not clean", "utf8");
    await store.saveIssueWorkspace(
      makeIssueWorkspace({
        workspaceKey,
        issueSubjectId: issue.id,
        issueIdentifier: issue.identifier,
        workspacePath,
        repositoryPath,
      })
    );
    await store.saveProjectIssueOrchestrations(projectConfig.projectId, [
      {
        issueId: issue.id,
        identifier: issue.identifier,
        workspaceKey,
        completedOnce: false,
        failureRetryCount: 0,
        state: "running",
        currentRunId: "run-routable-1",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun(
      makeRun({
        runId: "run-routable-1",
        issueId: issue.id,
        issueSubjectId: issue.id,
        issueIdentifier: issue.identifier,
        issueState: issue.state,
        repository,
        processId: 5411,
        issueWorkspaceKey: workspaceKey,
      })
    );

    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
      createDispatchAdapter(repository, [issue])
    );
    const killImpl = vi.fn();
    const result = await new OrchestratorService(store, projectConfig, {
      now: () => new Date("2026-03-08T00:05:00.000Z"),
      killImpl,
      isProcessRunning: vi.fn().mockReturnValue(true),
    }).runOnce();

    expect(result.summary.suppressed).toBe(1);
    expect(killImpl).toHaveBeenCalledWith(5411, "SIGTERM");
    expect(await readFile(sentinelPath, "utf8")).toBe("do not clean");
    expect(
      await store.loadIssueWorkspace(projectConfig.projectId, workspaceKey)
    ).toEqual(expect.objectContaining({ status: "active" }));
    expect(
      await store.loadRun("run-routable-1", projectConfig.projectId)
    ).toEqual(
      expect.objectContaining({
        status: "suppressed",
        runPhase: "canceled_by_reconciliation",
        recovery: expect.objectContaining({
          kind: "incomplete-turn-dirty-workspace",
          workspacePath: repositoryPath,
          dirtyFiles: ["preserve.txt"],
        }),
        lastError: expect.stringContaining("missing required labels"),
      })
    );
  });
});

describe("targeted canonical subject dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not suppress an unrelated active run during targeted reconciliation", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-targeted-active-run-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const targetIssue = makeIssue({
      id: "issue-7",
      identifier: "dispatch-acme/platform#7",
      number: 7,
      state: "In review",
      repository,
    });
    const activeIssue = makeIssue({
      id: "issue-8",
      identifier: "dispatch-acme/platform#8",
      number: 8,
      state: "Todo",
      repository,
    });
    await store.saveProjectIssueOrchestrations(projectConfig.projectId, [
      {
        issueId: activeIssue.id,
        identifier: activeIssue.identifier,
        workspaceKey: "acme-platform-8",
        completedOnce: false,
        failureRetryCount: 0,
        state: "running",
        currentRunId: "run-active-8",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun(
      makeRun({
        runId: "run-active-8",
        issueId: activeIssue.id,
        issueSubjectId: activeIssue.id,
        issueIdentifier: activeIssue.identifier,
        issueState: activeIssue.state,
        repository,
        processId: 5400,
        issueWorkspaceKey: "acme-platform-8",
      })
    );

    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
      createDispatchAdapter(repository, [targetIssue, activeIssue])
    );
    const killImpl = vi.fn();
    const service = new OrchestratorService(store, projectConfig, {
      now: () => new Date("2026-03-08T00:05:00.000Z"),
      killImpl,
      isProcessRunning: vi.fn().mockReturnValue(true),
      spawnImpl: vi.fn() as never,
    });

    const result = await service.runOnce({
      issueIdentifier: targetIssue.identifier,
    });

    expect(result.summary.suppressed).toBe(0);
    expect(killImpl).not.toHaveBeenCalled();
    expect(
      await store.loadRun("run-active-8", projectConfig.projectId)
    ).toEqual(
      expect.objectContaining({
        status: "running",
        processId: 5400,
      })
    );
    expect(
      await store.loadProjectIssueOrchestrations(projectConfig.projectId)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueId: activeIssue.id,
          state: "running",
          currentRunId: "run-active-8",
        }),
      ])
    );
  });

  it("uses each repository lifecycle for targeted terminal reconciliation", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-targeted-terminal-lifecycle-")
    );
    const defaultRepository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const alternateRepository = await createRepositoryFixture(
      tempRoot,
      "other",
      "service",
      { activeStates: ["Doing"], terminalStates: ["Closed"] }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      defaultRepository.cloneUrl,
      defaultRepository.owner,
      defaultRepository.name
    );
    await store.saveProjectConfig(projectConfig);

    const defaultIssue = makeIssue({
      id: "issue-default",
      identifier: "dispatch-acme/platform#9",
      number: 9,
      state: "Done",
      repository: defaultRepository,
    });
    const targetIssue = makeIssue({
      id: "issue-target",
      identifier: "other/service#10",
      number: 10,
      state: "Closed",
      repository: alternateRepository,
    });
    const workspaceKey = deriveIssueWorkspaceKey(
      {
        adapter: "github-project",
        issueSubjectId: targetIssue.id,
      },
      targetIssue.identifier
    );
    const workspacePath = resolveIssueWorkspaceDirectory(
      store.projectDir(projectConfig.projectId),
      workspaceKey
    );
    const repositoryPath = join(workspacePath, "repository");
    const sentinelPath = join(workspacePath, "sentinel.txt");
    await mkdir(repositoryPath, { recursive: true });
    await writeFile(sentinelPath, "cleanup me", "utf8");
    await store.saveIssueWorkspace(
      makeIssueWorkspace({
        workspaceKey,
        issueSubjectId: targetIssue.id,
        issueIdentifier: targetIssue.identifier,
        workspacePath,
        repositoryPath,
      })
    );
    await store.saveProjectIssueOrchestrations(projectConfig.projectId, [
      {
        issueId: targetIssue.id,
        identifier: targetIssue.identifier,
        workspaceKey,
        completedOnce: false,
        failureRetryCount: 0,
        state: "running",
        currentRunId: "run-target-10",
        retryEntry: null,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);
    await store.saveRun(
      makeRun({
        runId: "run-target-10",
        issueId: targetIssue.id,
        issueSubjectId: targetIssue.id,
        issueIdentifier: targetIssue.identifier,
        issueState: "Doing",
        repository: alternateRepository,
        processId: 5401,
        issueWorkspaceKey: workspaceKey,
      })
    );

    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
      createDispatchAdapter(defaultRepository, [defaultIssue, targetIssue])
    );
    const killImpl = vi.fn();
    const service = new OrchestratorService(store, projectConfig, {
      now: () => new Date("2026-03-08T00:05:00.000Z"),
      killImpl,
      isProcessRunning: vi.fn().mockReturnValue(true),
      spawnImpl: vi.fn() as never,
    });

    const result = await service.runOnce({
      issueIdentifier: targetIssue.identifier,
    });

    expect(result.summary.suppressed).toBe(1);
    expect(killImpl).toHaveBeenCalledWith(5401, "SIGTERM");
    expect(
      await store.loadRun("run-target-10", projectConfig.projectId)
    ).toEqual(
      expect.objectContaining({
        status: "suppressed",
        lastError:
          "Run suppressed because the tracker issue moved to a terminal state.",
      })
    );
    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
    expect(
      await store.loadIssueWorkspace(projectConfig.projectId, workspaceKey)
    ).toEqual(expect.objectContaining({ status: "removed" }));
  });

  it("dispatches the canonical Issue when targeting a linked PR identifier", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-targeted-pr-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);
    createPullRequestBranch(repository, "feature/pr-107");

    const issue = makeIssue({
      id: "issue-7",
      identifier: "dispatch-acme/platform#7",
      number: 7,
      state: "Todo",
      repository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-issue-7",
      },
      metadata: {
        contentType: "Issue",
        linkedPullRequests: [
          makePullRequestContext(repository, 107, "feature/pr-107"),
        ],
      },
    });
    const linkedPullRequest = makeIssue({
      id: "pr-107",
      identifier: "dispatch-acme/platform#107",
      number: 107,
      state: "Todo",
      repository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-pr-107",
      },
      metadata: {
        contentType: "PullRequest",
        pullRequest: makePullRequestContext(repository, 107, "feature/pr-107"),
      },
    });
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
      createDispatchAdapter(repository, [issue, linkedPullRequest])
    );

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5401, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce({
      issueIdentifier: "dispatch-acme/platform#107",
    });

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_IDENTIFIER: "dispatch-acme/platform#7",
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-7",
        }),
      })
    );
  });

  it.each(["Done", "In review"])(
    "does not dispatch a canonical Issue in %s when targeting a linked PR identifier",
    async (state) => {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "orchestrator-targeted-pr-suppressed-")
      );
      const repository = await createRepositoryFixture(
        tempRoot,
        "dispatch-acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(
        tempRoot,
        repository.cloneUrl,
        repository.owner,
        repository.name
      );
      await store.saveProjectConfig(projectConfig);

      const issue = makeIssue({
        id: "issue-8",
        identifier: "dispatch-acme/platform#8",
        number: 8,
        state,
        repository,
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          itemId: "item-issue-8",
        },
        metadata: {
          contentType: "Issue",
          linkedPullRequests: [
            makePullRequestContext(repository, 108, "feature/pr-108"),
          ],
        },
      });
      const linkedPullRequest = makeIssue({
        id: "pr-108",
        identifier: "dispatch-acme/platform#108",
        number: 108,
        state: "Todo",
        repository,
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          itemId: "item-pr-108",
        },
        metadata: {
          contentType: "PullRequest",
          pullRequest: makePullRequestContext(
            repository,
            108,
            "feature/pr-108"
          ),
        },
      });
      vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
        createDispatchAdapter(repository, [issue, linkedPullRequest])
      );

      const spawnImpl = vi.fn().mockReturnValue({ pid: 5402, unref: vi.fn() });
      const service = new OrchestratorService(store, projectConfig, {
        spawnImpl: spawnImpl as never,
        now: () => new Date("2026-03-08T00:00:00.000Z"),
      });

      const result = await service.runOnce({
        issueIdentifier: "dispatch-acme/platform#108",
      });

      expect(result.summary.dispatched).toBe(0);
      expect(spawnImpl).not.toHaveBeenCalled();
    }
  );

  it.each(["Todo", "In Progress"])(
    "does not author an advisory or dispatch when linked PR is %s but canonical Issue is inactive",
    async (pullRequestState) => {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "orchestrator-linked-pr-active-advisory-")
      );
      const repository = await createRepositoryFixture(
        tempRoot,
        "dispatch-acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = createProjectConfig(
        tempRoot,
        repository.cloneUrl,
        repository.owner,
        repository.name
      );
      await store.saveProjectConfig(projectConfig);

      const issue = makeIssue({
        id: "issue-9",
        identifier: "dispatch-acme/platform#9",
        number: 9,
        state: "In review",
        repository,
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          itemId: "item-issue-9",
        },
        metadata: {
          contentType: "Issue",
          linkedPullRequests: [
            makePullRequestContext(repository, 109, "feature/pr-109"),
          ],
        },
      });
      const linkedPullRequest = makeIssue({
        id: "pr-109",
        identifier: "dispatch-acme/platform#109",
        number: 109,
        state: pullRequestState,
        repository,
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          itemId: "item-pr-109",
        },
        metadata: {
          contentType: "PullRequest",
          pullRequest: makePullRequestContext(
            repository,
            109,
            "feature/pr-109"
          ),
        },
      });
      const adapter = createDispatchAdapter(repository, [
        issue,
        linkedPullRequest,
      ]);
      const upsertIssueComment = vi.fn().mockResolvedValue("created");
      adapter.upsertIssueComment = upsertIssueComment;
      vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
        adapter
      );

      const spawnImpl = vi.fn().mockReturnValue({ pid: 5406, unref: vi.fn() });
      const service = new OrchestratorService(store, projectConfig, {
        spawnImpl: spawnImpl as never,
        now: () => new Date("2026-03-08T00:00:00.000Z"),
      });

      const result = await service.runOnce({
        issueIdentifier: "dispatch-acme/platform#109",
      });

      expect(result.summary.dispatched).toBe(0);
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(upsertIssueComment).not.toHaveBeenCalled();
    }
  );

  it("does not post an advisory when the canonical Issue is already active", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-linked-pr-active-canonical-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const issue = makeIssue({
      id: "issue-active",
      identifier: "dispatch-acme/platform#10",
      state: "Todo",
      repository,
      metadata: {
        contentType: "Issue",
        linkedPullRequests: [
          makePullRequestContext(repository, 110, "feature/pr-110"),
        ],
      },
    });
    const linkedPullRequest = makeIssue({
      id: "pr-active",
      identifier: "dispatch-acme/platform#110",
      state: "In Progress",
      repository,
      metadata: {
        contentType: "PullRequest",
        pullRequest: makePullRequestContext(repository, 110, "feature/pr-110"),
      },
    });
    const adapter = createDispatchAdapter(repository, [
      issue,
      linkedPullRequest,
    ]);
    const upsertIssueComment = vi.fn().mockResolvedValue({
      outcome: "created",
      rateLimits: null,
    });
    adapter.upsertIssueComment = upsertIssueComment;
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(adapter);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5410, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce({ issueIdentifier: issue.identifier });

    expect(result.summary.dispatched).toBe(1);
    expect(upsertIssueComment).not.toHaveBeenCalled();
  });

  it("evaluates linked PR advisory states with each issue repository workflow", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-linked-pr-advisory-per-repo-workflow-")
    );
    const defaultRepository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const alternateRepository = await createRepositoryFixture(
      tempRoot,
      "other",
      "service",
      { activeStates: ["Doing"] }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      defaultRepository.cloneUrl,
      defaultRepository.owner,
      defaultRepository.name
    );
    await store.saveProjectConfig(projectConfig);

    const defaultIssue = makeIssue({
      id: "issue-10",
      identifier: "dispatch-acme/platform#10",
      number: 10,
      state: "Done",
      repository: defaultRepository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-issue-10",
      },
      metadata: { contentType: "Issue" },
    });
    const alternateIssue = makeIssue({
      id: "issue-11",
      identifier: "other/service#11",
      number: 11,
      state: "Review",
      repository: alternateRepository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-issue-11",
      },
      metadata: {
        contentType: "Issue",
        linkedPullRequests: [
          makePullRequestContext(alternateRepository, 111, "feature/pr-111"),
        ],
      },
    });
    const alternatePullRequest = makeIssue({
      id: "pr-111",
      identifier: "other/service#111",
      number: 111,
      state: "Todo",
      repository: alternateRepository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-pr-111",
      },
      metadata: {
        contentType: "PullRequest",
        pullRequest: makePullRequestContext(
          alternateRepository,
          111,
          "feature/pr-111"
        ),
      },
    });
    const adapter = createDispatchAdapter(defaultRepository, [
      defaultIssue,
      alternateIssue,
      alternatePullRequest,
    ]);
    const upsertIssueComment = vi.fn().mockResolvedValue("created");
    adapter.upsertIssueComment = upsertIssueComment;
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(adapter);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5410, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(0);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(upsertIssueComment).not.toHaveBeenCalled();
  });

  it("dispatches a standalone PR subject when targeting its identifier", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-targeted-standalone-pr-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);
    createPullRequestBranch(repository, "feature/pr-109");

    const pullRequest = makeIssue({
      id: "pr-109",
      identifier: "dispatch-acme/platform#109",
      number: 109,
      state: "Todo",
      repository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-pr-109",
      },
      metadata: {
        contentType: "PullRequest",
        pullRequest: makePullRequestContext(repository, 109, "feature/pr-109"),
      },
    });
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
      createDispatchAdapter(repository, [pullRequest])
    );

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5403, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce({
      issueIdentifier: "dispatch-acme/platform#109",
    });

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_IDENTIFIER: "dispatch-acme/platform#109",
          SYMPHONY_ISSUE_SUBJECT_ID: "pr-109",
        }),
      })
    );
  });

  it("continues dispatching existing Issue identifier targets", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-targeted-issue-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const issue = makeIssue({
      id: "issue-10",
      identifier: "dispatch-acme/platform#10",
      number: 10,
      state: "Todo",
      repository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-issue-10",
      },
      metadata: {
        contentType: "Issue",
      },
    });
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
      createDispatchAdapter(repository, [issue])
    );

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5404, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce({
      issueIdentifier: "dispatch-acme/platform#10",
    });

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_IDENTIFIER: "dispatch-acme/platform#10",
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-10",
        }),
      })
    );
  });

  it("keeps default project scans deduped under the canonical Issue subject", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-default-pr-dedup-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);
    createPullRequestBranch(repository, "feature/pr-111");

    const issue = makeIssue({
      id: "issue-11",
      identifier: "dispatch-acme/platform#11",
      number: 11,
      state: "Todo",
      repository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-issue-11",
      },
      metadata: {
        contentType: "Issue",
        linkedPullRequests: [
          makePullRequestContext(repository, 111, "feature/pr-111"),
        ],
      },
    });
    const linkedPullRequest = makeIssue({
      id: "pr-111",
      identifier: "dispatch-acme/platform#111",
      number: 111,
      state: "Todo",
      repository,
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-pr-111",
      },
      metadata: {
        contentType: "PullRequest",
        pullRequest: makePullRequestContext(repository, 111, "feature/pr-111"),
      },
    });
    vi.spyOn(trackerAdapters, "resolveTrackerAdapter").mockReturnValue(
      createDispatchAdapter(repository, [issue, linkedPullRequest])
    );

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5405, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_IDENTIFIER: "dispatch-acme/platform#11",
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-11",
        }),
      })
    );
  });
});

describe("codex policy propagation", () => {
  const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_GRAPHQL_TOKEN;
    } else {
      process.env.GITHUB_GRAPHQL_TOKEN = originalToken;
    }
  });

  it("passes workflow codex policies through worker environment", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-codex-policy-")
    );
    const repository = await createRepositoryFixture(
      tempRoot,
      "dispatch-acme",
      "platform",
      {
        codex: {
          approvalPolicy: "never",
          threadSandbox: "workspace-write",
          turnSandboxPolicy: "workspace-write",
        },
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    const projectConfig = createProjectConfig(
      tempRoot,
      repository.cloneUrl,
      repository.owner,
      repository.name
    );
    await store.saveProjectConfig(projectConfig);

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5301, unref: vi.fn() });
    const service = new OrchestratorService(store, projectConfig, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createTrackerResponse(repository, ["Todo"])),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringMatching(/worker/)],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_APPROVAL_POLICY: "never",
          SYMPHONY_ISSUE_TITLE: "Issue 1",
          SYMPHONY_THREAD_SANDBOX: "workspace-write",
          SYMPHONY_TURN_SANDBOX_POLICY: "workspace-write",
        }),
      })
    );
  });
});

async function createRepositoryFixture(
  root: string,
  owner: string,
  name: string,
  options: {
    activeStates?: string[];
    terminalStates?: string[];
    requiredLabels?: string[];
    maxConcurrentByState?: Record<string, number>;
    codex?: {
      approvalPolicy?: string;
      threadSandbox?: string;
      turnSandboxPolicy?: string;
    };
  } = {}
): Promise<{
  owner: string;
  name: string;
  cloneUrl: string;
  path: string;
}> {
  const repositoryRoot = join(root, `${owner}-${name}`);
  execSync(`mkdir -p ${shell(repositoryRoot)}`);
  execSync(`git init ${shell(repositoryRoot)}`, { stdio: "ignore" });
  execSync(
    `git -C ${shell(repositoryRoot)} config user.email tester@example.com`
  );
  execSync(`git -C ${shell(repositoryRoot)} config user.name tester`);
  await writeWorkflowFixture(repositoryRoot, options);
  execSync(`git -C ${shell(repositoryRoot)} add WORKFLOW.md`, {
    stdio: "ignore",
  });
  execSync(`git -C ${shell(repositoryRoot)} commit -m init`, {
    stdio: "ignore",
  });

  return {
    owner,
    name,
    cloneUrl: repositoryRoot,
    path: repositoryRoot,
  };
}

async function writeWorkflowFixture(
  repositoryRoot: string,
  options: {
    activeStates?: string[];
    terminalStates?: string[];
    requiredLabels?: string[];
    maxConcurrentByState?: Record<string, number>;
    codex?: {
      approvalPolicy?: string;
      threadSandbox?: string;
      turnSandboxPolicy?: string;
    };
  } = {}
): Promise<void> {
  const activeStates = options.activeStates ?? ["Todo", "In Progress"];
  const terminalStates = options.terminalStates ?? ["Done"];
  const activeStateLines = activeStates
    .map((state) => `    - ${state}`)
    .join("\n");
  const terminalStateLines = terminalStates
    .map((state) => `    - ${state}`)
    .join("\n");
  const requiredLabelLines = options.requiredLabels
    ? `  required_labels:\n${options.requiredLabels
        .map((label) => `    - ${label}`)
        .join("\n")}\n`
    : "";
  const maxConcurrentByState = options.maxConcurrentByState
    ? `  max_concurrent_agents_by_state:\n${Object.entries(
        options.maxConcurrentByState
      )
        .map(([state, limit]) => `    ${state}: ${limit}`)
        .join("\n")}\n`
    : "";
  const codexPolicyLines = [
    options.codex?.approvalPolicy
      ? `  approval_policy: ${options.codex.approvalPolicy}`
      : null,
    options.codex?.threadSandbox
      ? `  thread_sandbox: ${options.codex.threadSandbox}`
      : null,
    options.codex?.turnSandboxPolicy
      ? `  turn_sandbox_policy: ${options.codex.turnSandboxPolicy}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  const codexBlock = [
    "codex:",
    "  command: codex app-server",
    ...(codexPolicyLines ? codexPolicyLines.split("\n") : []),
    "  read_timeout_ms: 5000",
    "  turn_timeout_ms: 3600000",
  ].join("\n");

  await writeFile(
    join(repositoryRoot, "WORKFLOW.md"),
    `---
tracker:
  kind: github-project
  provider:
    project_id: project-123
    state_field: Status
    blocker_check_states:
      - Todo
  active_states:
${activeStateLines}
  terminal_states:
${terminalStateLines}
${requiredLabelLines}
hooks:
  after_create: hooks/after_create.sh
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
${maxConcurrentByState}${codexBlock}
---
Prefer focused changes.
`,
    "utf8"
  );
}

function createProjectConfig(
  tempRoot: string,
  cloneUrl: string,
  owner: string,
  name: string
) {
  return {
    projectId: "tenant-1",
    // Clone-era tests could reuse one branch name across temporary project
    // roots. Worktree population requires each independently running fixture
    // to own a distinct branch in the shared bare cache.
    slug: basename(tempRoot),
    workspaceDir: join(tempRoot, "workspaces", "tenant-1"),
    repository: {
      owner,
      name,
      cloneUrl,
    },
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
        repository: `${owner}/${name}`,
      },
    },
  };
}

function createDispatchAdapter(
  repository: {
    owner: string;
    name: string;
    cloneUrl: string;
  },
  issues: TrackedIssue[]
): OrchestratorTrackerAdapter {
  return {
    listIssues: vi.fn().mockResolvedValue(issues),
    listIssuesByStates: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
    buildWorkerEnvironment: () => ({ GITHUB_PROJECT_ID: "project-123" }),
    reviveIssue: (
      _tenant: OrchestratorProjectConfig,
      run: OrchestratorRunRecord
    ) =>
      makeIssue({
        id: run.issueId,
        identifier: run.issueIdentifier,
        state: run.issueState,
        repository: {
          owner: repository.owner,
          name: repository.name,
          cloneUrl: repository.cloneUrl,
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          itemId: run.issueId,
        },
      }),
    getTrackerItemId: (issue) =>
      (typeof issue.nativeRef?.itemId === "string"
        ? issue.nativeRef.itemId
        : issue.tracker.itemId) ?? null,
    resolveCanonicalIssues: (candidates) => {
      const pullRequests = new Map(
        candidates
          .filter((issue) => issue.contentType === "PullRequest")
          .map((issue) => [issue.id, issue])
      );
      const linked = new Set<string>();
      return candidates
        .flatMap((issue) => {
          if (issue.contentType === "PullRequest") {
            return [];
          }
          const references = issue.linkedPullRequests ?? [];
          for (const reference of references) linked.add(reference.id);
          const resolved = references.map((reference) => {
            const projectItem = pullRequests.get(reference.id);
            return projectItem
              ? { ...reference, projectState: projectItem.state }
              : reference;
          });
          return [
            references.some((reference) => pullRequests.has(reference.id))
              ? {
                  ...issue,
                  linkedPullRequests: resolved,
                }
              : issue,
          ];
        })
        .concat(
          candidates.filter(
            (issue) =>
              issue.contentType === "PullRequest" && !linked.has(issue.id)
          )
        );
    },
    matchesIssueIdentifier: (issue, identifier) =>
      issue.identifier === identifier ||
      issue.linkedPullRequests?.some(
        (pullRequest) => pullRequest.identifier === identifier
      ) === true,
    findActiveLinkedPullRequest: (issue, lifecycle) => {
      const states = new Set(
        lifecycle.activeStates.map((state) => state.toLowerCase())
      );
      const pullRequest = issue.linkedPullRequests?.find(
        (candidate) =>
          typeof candidate.projectState === "string" &&
          states.has(candidate.projectState.toLowerCase())
      );
      return pullRequest?.projectState
        ? {
            id: pullRequest.id,
            identifier: pullRequest.identifier,
            projectState: pullRequest.projectState,
          }
        : null;
    },
  };
}

function createTrackerResponse(
  repository: {
    owner: string;
    name: string;
    cloneUrl: string;
  },
  states: string[]
) {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          __typename: "ProjectV2",
          items: {
            nodes: states.map((state, index) => ({
              id: `item-${index + 1}`,
              updatedAt: "2026-03-08T00:00:00.000Z",
              fieldValues: {
                nodes: [
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: state,
                    field: {
                      name: "Status",
                    },
                  },
                ],
              },
              content: {
                __typename: "Issue",
                id: `issue-${index + 1}`,
                number: index + 1,
                title: `Issue ${index + 1}`,
                body: null,
                url: `https://example.test/${repository.owner}/${repository.name}/issues/${index + 1}`,
                createdAt: `2026-03-0${index + 1}T00:00:00.000Z`,
                updatedAt: `2026-03-0${index + 1}T00:00:00.000Z`,
                labels: {
                  nodes: [],
                },
                repository: {
                  name: repository.name,
                  url: `file://${repository.cloneUrl}`,
                  owner: {
                    login: repository.owner,
                  },
                },
              },
            })),
            pageInfo: {
              endCursor: null,
              hasNextPage: false,
            },
          },
        },
      },
    }),
  };
}

function shell(value: string): string {
  return JSON.stringify(value);
}

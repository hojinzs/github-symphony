import { execSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sortCandidatesForDispatch, OrchestratorService } from "./service.js";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorRunRecord,
  OrchestratorTenantConfig,
  TrackedIssue,
} from "@gh-symphony/core";
import { OrchestratorFsStore } from "./fs-store.js";
import * as trackerAdapters from "./tracker-adapters.js";

function makeIssue(
  overrides: Partial<TrackedIssue> & { identifier: string }
): TrackedIssue {
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
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner: "acme",
      name: "repo",
      cloneUrl: "https://github.com/acme/repo.git",
    },
    tracker: {
      adapter: "github-project",
      bindingId: "proj-1",
      itemId: "item-1",
    },
    metadata: {},
    ...overrides,
  };
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

  it("breaks ties by createdAt oldest first", () => {
    const sorted = sortCandidatesForDispatch([
      makeIssue({
        identifier: "acme/repo#2",
        priority: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
      }),
      makeIssue({
        identifier: "acme/repo#1",
        priority: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
      }),
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual([
      "acme/repo#1",
      "acme/repo#2",
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
      "acme",
      "platform",
      {
        maxConcurrentByState: {
          Todo: 1,
        },
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveTenantConfig(
      createTenantConfig(
        tempRoot,
        repository.cloneUrl,
        repository.owner,
        repository.name
      )
    );

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5101, unref: vi.fn() });
    const service = new OrchestratorService(store, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          createTrackerResponse(repository, ["Todo", "Todo", "Todo"])
        ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result[0]?.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("dispatches all three issues in Todo state when Todo limit is 3", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-dispatch-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform",
      {
        maxConcurrentByState: {
          Todo: 3,
        },
      }
    );
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveTenantConfig(
      createTenantConfig(
        tempRoot,
        repository.cloneUrl,
        repository.owner,
        repository.name
      )
    );

    const spawnImpl = vi.fn().mockReturnValue({ pid: 5102, unref: vi.fn() });
    const service = new OrchestratorService(store, {
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          createTrackerResponse(repository, ["Todo", "Todo", "Todo"])
        ),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result[0]?.summary.dispatched).toBe(3);
    expect(spawnImpl).toHaveBeenCalledTimes(3);
  });
});

describe("blocker eligibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches unblocked issue and skips issue blocked by non-terminal blocker", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-blocker-"));
    const repository = await createRepositoryFixture(
      tempRoot,
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveTenantConfig(
      createTenantConfig(
        tempRoot,
        repository.cloneUrl,
        repository.owner,
        repository.name
      )
    );

    const issueA = makeIssue({
      id: "issue-1",
      identifier: "acme/platform#1",
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
      identifier: "acme/platform#2",
      number: 2,
      state: "Todo",
      blockedBy: ["acme/platform#1"],
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
      buildWorkerEnvironment: () => ({ GITHUB_PROJECT_ID: "project-123" }),
      reviveIssue: (
        _tenant: OrchestratorTenantConfig,
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
    const service = new OrchestratorService(store, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result[0]?.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "node packages/worker/dist/index.js"],
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
      "acme",
      "platform"
    );
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveTenantConfig(
      createTenantConfig(
        tempRoot,
        repository.cloneUrl,
        repository.owner,
        repository.name
      )
    );

    const issueA = makeIssue({
      id: "issue-1",
      identifier: "acme/platform#1",
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
      identifier: "acme/platform#2",
      number: 2,
      state: "Todo",
      blockedBy: ["acme/platform#1"],
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
      buildWorkerEnvironment: () => ({ GITHUB_PROJECT_ID: "project-123" }),
      reviveIssue: (
        _tenant: OrchestratorTenantConfig,
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
    const service = new OrchestratorService(store, {
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
    });

    const result = await service.runOnce();

    expect(result[0]?.summary.dispatched).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "node packages/worker/dist/index.js"],
      expect.objectContaining({
        env: expect.objectContaining({
          SYMPHONY_ISSUE_SUBJECT_ID: "issue-2",
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
    maxConcurrentByState?: Record<string, number>;
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
    maxConcurrentByState?: Record<string, number>;
  } = {}
): Promise<void> {
  const maxConcurrentByState = options.maxConcurrentByState
    ? `max_concurrent_by_state:\n${Object.entries(options.maxConcurrentByState)
        .map(([state, limit]) => `  ${state}: ${limit}`)
        .join("\n")}\n`
    : "";

  await writeFile(
    join(repositoryRoot, "WORKFLOW.md"),
    `---
github_project_id: project-123
lifecycle:
  state_field: Status
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
${maxConcurrentByState}runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
scheduler:
  poll_interval_ms: 30000
retry:
  base_delay_ms: 1000
  max_delay_ms: 30000
---
Prefer focused changes.
`,
    "utf8"
  );
}

function createTenantConfig(
  tempRoot: string,
  cloneUrl: string,
  owner: string,
  name: string
) {
  return {
    tenantId: "tenant-1",
    slug: "tenant-1",

    repositories: [
      {
        owner,
        name,
        cloneUrl,
      },
    ],
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    },
    runtime: {
      driver: "local" as const,
      workspaceRuntimeDir: join(tempRoot, "workspaces", "tenant-1"),
      projectRoot: process.cwd(),
      workerCommand: "node packages/worker/dist/index.js",
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

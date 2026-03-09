import { execSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorFsStore } from "./fs-store.js";
import { OrchestratorService } from "./service.js";

describe("OrchestratorService", () => {
  const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_GRAPHQL_TOKEN;
    } else {
      process.env.GITHUB_GRAPHQL_TOKEN = originalToken;
    }
  });

  it("dispatches actionable issues and prevents duplicate issue-phase leases", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
    const repository = await createRepositoryFixture(tempRoot, "acme", "platform");
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveWorkspaceConfig({
      workspaceId: "workspace-1",
      slug: "workspace-1",
      promptGuidelines: "Prefer focused changes.",
      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123"
        }
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "workspace-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js"
      }
    });

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4101,
      unref: vi.fn()
    });
    const service = new OrchestratorService(store, {
      fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:00:00.000Z")
    });

    const first = await service.runOnce();
    const second = await service.runOnce();
    const leases = await store.loadWorkspaceLeases("workspace-1");

    expect(first[0]?.summary.dispatched).toBe(1);
    expect(first[0]?.tracker).toEqual({
      adapter: "github-project",
      bindingId: "project-123"
    });
    expect(second[0]?.summary.dispatched).toBe(0);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.status).toBe("active");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "node packages/worker/dist/index.js"],
      expect.objectContaining({
        env: expect.objectContaining({
          GITHUB_PROJECT_ID: "project-123",
          SYMPHONY_TRACKER_ADAPTER: "github-project",
          SYMPHONY_TRACKER_BINDING_ID: "project-123",
          SYMPHONY_TRACKER_ITEM_ID: "item-1"
        })
      })
    );
  });

  it("restarts retrying runs after backoff elapses", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-retry-"));
    const repository = await createRepositoryFixture(tempRoot, "acme", "platform");
    const store = new OrchestratorFsStore(tempRoot);
    await store.saveWorkspaceConfig({
      workspaceId: "workspace-1",
      slug: "workspace-1",
      promptGuidelines: "Prefer focused changes.",
      repositories: [repository],
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123"
        }
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir: join(tempRoot, "workspaces", "workspace-1"),
        projectRoot: process.cwd(),
        workerCommand: "node packages/worker/dist/index.js"
      }
    });
    await store.saveWorkspaceLeases("workspace-1", [
      {
        leaseKey: "issue-1:planning",
        runId: "run-1",
        issueId: "issue-1",
        issueIdentifier: "acme/platform#1",
        phase: "planning",
        status: "active",
        updatedAt: "2026-03-08T00:00:00.000Z"
      }
    ]);
    await store.saveRun({
      runId: "run-1",
      workspaceId: "workspace-1",
      workspaceSlug: "workspace-1",
      issueId: "issue-1",
      issueIdentifier: "acme/platform#1",
      phase: "planning",
      repository,
      status: "retrying",
      attempt: 2,
      processId: null,
      port: 4601,
      workingDirectory: join(tempRoot, "stale-run"),
      workspaceRuntimeDir: join(tempRoot, "stale-run", "workspace-runtime"),
      workflowPath: null,
      retryKind: "failure",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:10.000Z",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: null,
      lastError: "Worker process exited unexpectedly.",
      nextRetryAt: "2026-03-08T00:00:20.000Z"
    });

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4102,
      unref: vi.fn()
    });
    const service = new OrchestratorService(store, {
      fetchImpl: vi.fn().mockResolvedValue(createEmptyTrackerResponse()),
      spawnImpl: spawnImpl as never,
      now: () => new Date("2026-03-08T00:01:00.000Z")
    });

    const result = await service.runOnce();

    expect(result[0]?.summary.recovered).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });
});

async function createRepositoryFixture(
  root: string,
  owner: string,
  name: string
): Promise<{
  owner: string;
  name: string;
  cloneUrl: string;
}> {
  const repositoryRoot = join(root, `${owner}-${name}`);
  execSync(`mkdir -p ${shell(repositoryRoot)}`);
  execSync(`git init ${shell(repositoryRoot)}`, { stdio: "ignore" });
  execSync(`git -C ${shell(repositoryRoot)} config user.email tester@example.com`);
  execSync(`git -C ${shell(repositoryRoot)} config user.name tester`);
  await writeFile(
    join(repositoryRoot, "WORKFLOW.md"),
    `---
github_project_id: project-123
lifecycle:
  state_field: Status
  planning_active:
    - Needs Plan
  human_review:
    - Human Review
  implementation_active:
    - Approved
  awaiting_merge:
    - Await Merge
  completed:
    - Done
  transitions:
    planning_complete: Human Review
    implementation_complete: Await Merge
    merge_complete: Done
runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
---
Prefer focused changes.
`,
    "utf8"
  );
  execSync(`git -C ${shell(repositoryRoot)} add WORKFLOW.md`, { stdio: "ignore" });
  execSync(`git -C ${shell(repositoryRoot)} commit -m init`, { stdio: "ignore" });

  return {
    owner,
    name,
    cloneUrl: repositoryRoot
  };
}

function createTrackerResponse(repository: {
  owner: string;
  name: string;
  cloneUrl: string;
}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          __typename: "ProjectV2",
          items: {
            nodes: [
              {
                id: "item-1",
                updatedAt: "2026-03-08T00:00:00.000Z",
                fieldValues: {
                  nodes: [
                    {
                      __typename: "ProjectV2ItemFieldSingleSelectValue",
                      name: "Needs Plan",
                      field: {
                        name: "Status"
                      }
                    }
                  ]
                },
                content: {
                  __typename: "Issue",
                  id: "issue-1",
                  number: 1,
                  title: "Implement orchestrator",
                  body: null,
                  url: `https://example.test/${repository.owner}/${repository.name}/issues/1`,
                  createdAt: "2026-03-08T00:00:00.000Z",
                  updatedAt: "2026-03-08T00:00:00.000Z",
                  labels: {
                    nodes: []
                  },
                  repository: {
                    name: repository.name,
                    url: `file://${repository.cloneUrl}`,
                    owner: {
                      login: repository.owner
                    }
                  }
                }
              }
            ],
            pageInfo: {
              endCursor: null,
              hasNextPage: false
            }
          }
        }
      }
    })
  };
}

function createEmptyTrackerResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          __typename: "ProjectV2",
          items: {
            nodes: [],
            pageInfo: {
              endCursor: null,
              hasNextPage: false
            }
          }
        }
      }
    })
  };
}

function shell(value: string): string {
  return JSON.stringify(value);
}

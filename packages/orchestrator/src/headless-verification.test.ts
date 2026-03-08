import { execSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { fetchWorkspaceOrchestratorStatus } from "../../../apps/control-plane/lib/orchestrator-status-client.ts";
import { OrchestratorFsStore } from "./fs-store.js";
import { runCli } from "./index.js";
import { OrchestratorService } from "./service.js";
import { resolveOrchestratorStatusResponse } from "./status-server.js";

describe("headless orchestration verification", () => {
  it("runs headlessly from the CLI and exposes status for optional extensions", async () => {
    const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";

    try {
      const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-headless-"));
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
        now: () => new Date("2026-03-09T00:00:00.000Z")
      });

      let stdout = "";
      await runCli(["run-once", "--runtime-root", tempRoot], {
        createService: () => service,
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          }
        }
      });

      const cliStatus = JSON.parse(stdout) as Array<{
        workspaceId: string;
        summary: {
          dispatched: number;
        };
      }>;
      expect(cliStatus[0]?.workspaceId).toBe("workspace-1");
      expect(cliStatus[0]?.summary.dispatched).toBe(1);

      const snapshot = await fetchWorkspaceOrchestratorStatus("workspace-1", {
        baseUrl: "http://orchestrator.test",
        fetchImpl: (async (input) => {
          const requestUrl =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          const resolved = await resolveOrchestratorStatusResponse(
            new URL(requestUrl).pathname,
            {
              all: () => service.status(),
              byWorkspaceId: async (workspaceId) => {
                const [status] = await service.status(workspaceId);
                return status ?? null;
              }
            }
          );

          return new Response(JSON.stringify(resolved.payload), {
            status: resolved.status,
            headers: {
              "content-type": "application/json"
            }
          });
        }) as typeof fetch
      });

      expect(snapshot).toMatchObject({
        workspaceId: "workspace-1",
        health: "running",
        tracker: {
          adapter: "github-project",
          bindingId: "project-123"
        }
      });
      expect(snapshot?.activeRuns[0]?.issueIdentifier).toBe("acme/platform#1");
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_GRAPHQL_TOKEN;
      } else {
        process.env.GITHUB_GRAPHQL_TOKEN = originalToken;
      }
    }
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
    `# Symphony Workflow

## Prompt Guidelines

Prefer focused changes.

## Approval Lifecycle

- State field: Status
- Planning-active states:
  - Needs Plan
- Human-review states:
  - Human Review
- Implementation-active states:
  - Approved
- Awaiting-merge states:
  - Await Merge
- Completed states:
  - Done
- Planning complete -> Human Review
- Implementation complete -> Await Merge
- Merge complete -> Done
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
                updatedAt: "2026-03-09T00:00:00.000Z",
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
                  createdAt: "2026-03-09T00:00:00.000Z",
                  updatedAt: "2026-03-09T00:00:00.000Z",
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

function shell(value: string): string {
  return JSON.stringify(value);
}

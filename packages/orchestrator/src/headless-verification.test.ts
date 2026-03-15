import { execSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { fetchProjectOrchestratorStatus } from "../../../apps/control-plane/lib/orchestrator-status-client.ts";
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
      const repository = await createRepositoryFixture(
        tempRoot,
        "acme",
        "platform"
      );
      const store = new OrchestratorFsStore(tempRoot);
      const projectConfig = {
        projectId: "tenant-1",
        slug: "tenant-1",
        workspaceDir: join(tempRoot, "workspaces", "tenant-1"),
        repositories: [repository],
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      };
      await store.saveProjectConfig(projectConfig);

      const spawnImpl = vi.fn().mockReturnValue({
        pid: 4101,
        unref: vi.fn(),
      });
      const service = new OrchestratorService(store, projectConfig, {
        fetchImpl: vi.fn().mockResolvedValue(createTrackerResponse(repository)),
        spawnImpl: spawnImpl as never,
        now: () => new Date("2026-03-09T00:00:00.000Z"),
      });

      let stdout = "";
      await runCli(["run-once", "--runtime-root", tempRoot], {
        createService: () => service,
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        },
      });

      const cliStatus = JSON.parse(stdout) as {
        projectId: string;
        summary: {
          dispatched: number;
        };
      };
      expect(cliStatus.projectId).toBe("tenant-1");
      expect(cliStatus.summary.dispatched).toBe(1);

      const snapshot = await fetchProjectOrchestratorStatus("tenant-1", {
        baseUrl: "http://orchestrator.test",
        fetchImpl: (async (input) => {
          const requestUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          const pathname = new URL(requestUrl).pathname;
          const resolved = await resolveOrchestratorStatusResponse(
            pathname,
            "GET",
            () => service.status()
          );

          return new Response(JSON.stringify(resolved.payload), {
            status: resolved.status,
            headers: {
              "content-type": "application/json",
            },
          });
        }) as typeof fetch,
      });

      expect(snapshot).toMatchObject({
        projectId: "tenant-1",
        health: "running",
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
        },
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
  execSync(
    `git -C ${shell(repositoryRoot)} config user.email tester@example.com`
  );
  execSync(`git -C ${shell(repositoryRoot)} config user.name tester`);
  await writeFile(
    join(repositoryRoot, "WORKFLOW.md"),
    `---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
hooks:
  after_create: hooks/after_create.sh
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
codex:
  command: codex app-server
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
---
Prefer focused changes.
`,
    "utf8"
  );
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
  };
}

function createTrackerResponse(repository: {
  owner: string;
  name: string;
  cloneUrl: string;
}, state = "Todo") {
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
                      name: state,
                      field: {
                        name: "Status",
                      },
                    },
                  ],
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
              },
            ],
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

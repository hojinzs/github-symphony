import { execSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { OrchestratorFsStore } from "./fs-store.js";
import { runCli } from "./index.js";
import { OrchestratorService } from "./service.js";

describe("headless orchestration verification", () => {
  it("runs headlessly from the CLI and exposes status for optional extensions", async () => {
    const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;
    const originalAllowHooks = process.env.SYMPHONY_ALLOW_WORKFLOW_HOOKS;
    process.env.GITHUB_GRAPHQL_TOKEN = "test-token";
    process.env.SYMPHONY_ALLOW_WORKFLOW_HOOKS = "1";

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
        repository,
        tracker: {
          adapter: "github-project" as const,
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
            repository: `${repository.owner}/${repository.name}`,
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
        repository: {
          owner: string;
          name: string;
        };
        tracker: {
          settings?: {
            projectId?: string;
          };
        };
        summary: {
          dispatched: number;
        };
      };
      expect(cliStatus).not.toHaveProperty("projectId");
      expect(cliStatus).not.toHaveProperty("slug");
      expect(cliStatus.repository).toEqual({
        owner: "acme",
        name: "platform",
        cloneUrl: repository.cloneUrl,
      });
      expect(cliStatus.tracker.settings?.projectId).toBe("project-123");
      expect(cliStatus.summary.dispatched).toBe(1);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_GRAPHQL_TOKEN;
      } else {
        process.env.GITHUB_GRAPHQL_TOKEN = originalToken;
      }
      if (originalAllowHooks === undefined) {
        delete process.env.SYMPHONY_ALLOW_WORKFLOW_HOOKS;
      } else {
        process.env.SYMPHONY_ALLOW_WORKFLOW_HOOKS = originalAllowHooks;
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
  provider:
    project_id: project-123
    state_field: Status
    blocker_check_states:
      - Todo
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
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
  await mkdir(join(repositoryRoot, "hooks"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "hooks", "after_create.sh"),
    '#!/usr/bin/env bash\nset -euo pipefail\ngit clone "$SYMPHONY_REPOSITORY_CLONE_URL" "$SYMPHONY_REPOSITORY_PATH" >/dev/null 2>&1\ngit -C "$SYMPHONY_REPOSITORY_PATH" checkout -B "$SYMPHONY_ASSIGNED_BRANCH" "origin/${SYMPHONY_BASE_BRANCH:-HEAD}" >/dev/null 2>&1\n',
    "utf8"
  );
  await chmod(join(repositoryRoot, "hooks", "after_create.sh"), 0o755);
  execSync(
    `git -C ${shell(repositoryRoot)} add WORKFLOW.md hooks/after_create.sh`,
    {
      stdio: "ignore",
    }
  );
  execSync(`git -C ${shell(repositoryRoot)} commit -m init`, {
    stdio: "ignore",
  });

  return {
    owner,
    name,
    cloneUrl: repositoryRoot,
  };
}

function createTrackerResponse(
  repository: {
    owner: string;
    name: string;
    cloneUrl: string;
  },
  state = "Todo"
) {
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

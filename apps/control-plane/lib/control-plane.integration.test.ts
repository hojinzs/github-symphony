import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceDashboard } from "./dashboard-service";
import { createIssueForWorkspace } from "./issue-service";
import { provisionWorkspace } from "./workspace-orchestrator";
import { createMemoryDatabase } from "./test-harness";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0, tempPaths.length).map((path) =>
      rm(path, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("Control-plane integration", () => {
  it("provisions a workspace, mediates GitHub issue creation, and aggregates runtime state", async () => {
    const { db } = createMemoryDatabase();
    const runtimeRoot = mkdtempSync(join(tmpdir(), "github-symphony-integration-"));
    tempPaths.push(runtimeRoot);

    const graphFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              user: { id: "owner-1" },
              organization: null
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              createProjectV2: {
                projectV2: {
                  id: "project-1",
                  number: 7,
                  title: "Platform Workspace",
                  url: "https://github.com/orgs/acme/projects/7"
                }
              }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              repository: { id: "repo-1" }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              createIssue: {
                issue: {
                  id: "issue-1",
                  number: 21,
                  url: "https://github.com/acme/platform/issues/21"
                }
              }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              addProjectV2ItemById: {
                item: {
                  id: "project-item-1"
                }
              }
            }
          }),
          { status: 200 }
        )
      );

    const docker = {
      createContainer: vi.fn().mockResolvedValue({
        id: "container-1",
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: {
            Running: true,
            Status: "running"
          }
        })
      }),
      getContainer: vi.fn()
    };

    const credentialBroker = vi.fn().mockResolvedValue({
      token: "ghs_installation",
      expiresAt: new Date("2026-03-07T11:00:00.000Z"),
      installationId: "installation-1",
      ownerLogin: "acme",
      ownerType: "Organization"
    });

    const { workspace, runtime } = await provisionWorkspace(
      {
        name: "Platform Workspace",
        promptGuidelines: "Prefer small changes",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      },
      {
        db,
        fetchImpl: graphFetch as typeof fetch,
        docker,
        runtimeRoot,
        portAllocator: async () => 4505,
        credentialBroker,
        runtimeAuthEnv: {
          WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-auth-secret"
        }
      }
    );

    const issue = await createIssueForWorkspace(
      {
        workspaceId: workspace.id,
        repositoryOwner: "acme",
        repositoryName: "platform",
        title: "Ship the dashboard",
        body: "Implement runtime observability."
      },
      {
        db,
        credentialBroker,
        createWorkspaceIssueImpl: (token, input) =>
          import("./github-projects").then(({ createWorkspaceIssue }) =>
            createWorkspaceIssue(token, input, graphFetch as typeof fetch)
          )
      }
    );

    const dashboard = await loadWorkspaceDashboard(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            activeTask: issue.number,
            projectId: workspace.githubProjectId
          }),
          { status: 200 }
        )
      ) as unknown as Promise<Response> as unknown as typeof fetch,
      db
    );

    expect(runtime.port).toBe(4505);
    expect(issue.projectItemId).toBe("project-item-1");
    expect(dashboard).toHaveLength(1);
    expect(dashboard[0]?.runtime).toMatchObject({
      status: "provisioning",
      port: 4505
    });
  });
});

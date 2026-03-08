import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCredentialProvider,
  AgentCredentialStatus,
  WorkspaceAgentCredentialSource
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markAgentCredentialDegraded } from "./agent-credentials";
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
    const seededCredential = await db.agentCredential.create({
      data: {
        label: "Platform default",
        provider: AgentCredentialProvider.openai,
        encryptedSecret: "encrypted-agent-secret",
        secretFingerprint: "fingerprint-platform-default",
        status: AgentCredentialStatus.ready,
        lastValidatedAt: new Date("2026-03-07T08:30:00.000Z"),
        degradedReason: null
      }
    });
    await db.platformAgentCredentialConfig.upsert({
      where: {
        singletonKey: "system"
      },
      update: {
        defaultAgentCredentialId: seededCredential.id
      },
      create: {
        singletonKey: "system",
        defaultAgentCredentialId: seededCredential.id
      }
    });
    const runtimeRoot = mkdtempSync(join(tmpdir(), "github-symphony-integration-"));
    tempPaths.push(runtimeRoot);

    const graphFetch = createGraphFetch();
    const docker = createDocker();

    const credentialBroker = vi.fn().mockResolvedValue({
      token: "ghp_machine_user",
      expiresAt: new Date("2026-03-07T11:00:00.000Z"),
      installationId: null,
      ownerLogin: "acme",
      ownerType: "Organization",
      provider: "pat_classic",
      source: "pat",
      actorLogin: "machine-user",
      tokenFingerprint: "pat-fingerprint"
    });

    const { workspace, runtime } = await provisionWorkspace(
      {
        name: "Platform Workspace",
        promptGuidelines: "Prefer small changes",
        agentCredentialSource: WorkspaceAgentCredentialSource.platform_default,
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
        createWorkspaceIssueImpl: (input) =>
          import("./github-projects").then(({ createWorkspaceIssue }) =>
            createWorkspaceIssue("machine-user-token", input, graphFetch as typeof fetch)
          )
      }
    );

    const dashboardFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: workspace.id,
            slug: workspace.slug,
            tracker: {
              adapter: "github-project",
              bindingId: workspace.githubProjectId
            },
            lastTickAt: "2026-03-09T00:00:00.000Z",
            health: "running",
            summary: {
              dispatched: 1,
              suppressed: 0,
              recovered: 0,
              activeRuns: 1
            },
            activeRuns: [
              {
                runId: "run-1",
                issueIdentifier: `acme/platform#${issue.number}`,
                phase: "planning",
                status: "running",
                port: 4505
              }
            ],
            lastError: null
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            activeTask: issue.number,
            projectId: workspace.githubProjectId
          }),
          { status: 200 }
        )
      ) as typeof fetch;

    const dashboard = await loadWorkspaceDashboard(
      dashboardFetch,
      db,
      {
        syncWorkspaceRuntimeStatusImpl: vi.fn().mockResolvedValue("running")
      }
    );

    expect(runtime.port).toBe(0);
    expect(issue.projectItemId).toBe("project-item-1");
    expect(dashboard).toHaveLength(1);
    expect(dashboard[0]?.agentCredential.status).toBe("ready");
    expect(dashboard[0]?.runtime).toMatchObject({
      driver: "docker",
      health: "healthy",
      status: "running",
      port: 4505
    });
    expect(dashboard[0]?.runtime?.state).toMatchObject({
      orchestrator: {
        workspaceId: workspace.id
      },
      worker: {
        activeTask: issue.number
      }
    });
  });

  it("supports PAT-backed workspace provisioning and issue creation for an organization owner", async () => {
    const { db } = createMemoryDatabase();
    const seededCredential = await db.agentCredential.create({
      data: {
        label: "Platform default",
        provider: AgentCredentialProvider.openai,
        encryptedSecret: "encrypted-agent-secret",
        secretFingerprint: "fingerprint-platform-default",
        status: AgentCredentialStatus.ready,
        lastValidatedAt: new Date("2026-03-07T08:31:00.000Z"),
        degradedReason: null
      }
    });
    await db.platformAgentCredentialConfig.upsert({
      where: {
        singletonKey: "system"
      },
      update: {
        defaultAgentCredentialId: seededCredential.id
      },
      create: {
        singletonKey: "system",
        defaultAgentCredentialId: seededCredential.id
      }
    });
    const runtimeRoot = mkdtempSync(join(tmpdir(), "github-symphony-pat-integration-"));
    tempPaths.push(runtimeRoot);

    const graphFetch = createGraphFetch();
    const docker = createDocker();
    const credentialBroker = vi.fn().mockResolvedValue({
      token: "ghp_machine_user",
      expiresAt: new Date("2026-03-07T11:15:00.000Z"),
      installationId: null,
      ownerLogin: "acme",
      ownerType: "Organization",
      provider: "pat_classic",
      source: "pat",
      actorLogin: "machine-user",
      tokenFingerprint: "pat-fingerprint"
    });

    const { workspace } = await provisionWorkspace(
      {
        name: "PAT Workspace",
        promptGuidelines: "Prefer small changes",
        agentCredentialSource: WorkspaceAgentCredentialSource.platform_default,
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
        portAllocator: async () => 4507,
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
        title: "PAT-backed issue",
        body: "Exercise the PAT provider path."
      },
      {
        db,
        credentialBroker,
        createWorkspaceIssueImpl: (input) =>
          import("./github-projects").then(({ createWorkspaceIssue }) =>
            createWorkspaceIssue("machine-user-token", input, graphFetch as typeof fetch)
          )
      }
    );

    expect(workspace.githubOwnerLogin).toBe("acme");
    expect(workspace.githubProjectId).toBe("project-1");
    expect(issue.url).toBe("https://github.com/acme/platform/issues/21");
    expect(issue.projectItemId).toBe("project-item-1");
  });

  it("supports workspace-specific overrides and surfaces degraded credential recovery state", async () => {
    const { db } = createMemoryDatabase();
    const overrideCredential = await db.agentCredential.create({
      data: {
        label: "Workspace override",
        provider: AgentCredentialProvider.openai,
        encryptedSecret: "encrypted-override-secret",
        secretFingerprint: "fingerprint-override",
        status: AgentCredentialStatus.ready,
        lastValidatedAt: new Date("2026-03-07T08:35:00.000Z"),
        degradedReason: null
      }
    });
    const runtimeRoot = mkdtempSync(join(tmpdir(), "github-symphony-override-"));
    tempPaths.push(runtimeRoot);

    const { workspace } = await provisionWorkspace(
      {
        name: "Override Workspace",
        promptGuidelines: "Prefer small changes",
        agentCredentialSource: WorkspaceAgentCredentialSource.workspace_override,
        agentCredentialId: overrideCredential.id,
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
        fetchImpl: createGraphFetch() as typeof fetch,
        docker: createDocker(),
        runtimeRoot,
        portAllocator: async () => 4506,
        credentialBroker: vi.fn().mockResolvedValue({
          token: "ghp_machine_user",
          expiresAt: new Date("2026-03-07T11:00:00.000Z"),
          installationId: null,
          ownerLogin: "acme",
          ownerType: "Organization",
          provider: "pat_classic",
          source: "pat",
          actorLogin: "machine-user",
          tokenFingerprint: "pat-fingerprint"
        }),
        runtimeAuthEnv: {
          WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-auth-secret"
        }
      }
    );

    await markAgentCredentialDegraded(
      {
        credentialId: overrideCredential.id,
        reason: "Rotate or replace the workspace override credential to resume runs."
      },
      db
    );

    const dashboard = await loadWorkspaceDashboard(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            activeTask: 0
          }),
          { status: 200 }
        )
      ) as unknown as Promise<Response> as unknown as typeof fetch,
      db,
      {
        syncWorkspaceRuntimeStatusImpl: vi.fn().mockResolvedValue("running")
      }
    );

    expect(workspace.agentCredentialSource).toBe(
      WorkspaceAgentCredentialSource.workspace_override
    );
    expect(dashboard[0]?.agentCredential).toMatchObject({
      source: WorkspaceAgentCredentialSource.workspace_override,
      status: "degraded",
      label: "Workspace override",
      message: "Rotate or replace the workspace override credential to resume runs."
    });
  });
});

function createGraphFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            organization: { id: "owner-1" }
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
}

function createDocker() {
  return {
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
}

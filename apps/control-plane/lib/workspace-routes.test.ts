import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./github-setup-guard", async () => {
  const actual =
    await vi.importActual<typeof import("./github-setup-guard")>("./github-setup-guard");

  return {
    ...actual,
    requireReadyGitHubSetup: vi.fn()
  };
});

vi.mock("./github-installation-repositories", () => ({
  listGitHubInstallationRepositories: vi.fn(),
  resolveGitHubInstallationRepositorySelection: vi.fn()
}));

vi.mock("./workspace-orchestrator", () => ({
  provisionWorkspace: vi.fn()
}));

vi.mock("./operator-auth-guard", async () => {
  const actual =
    await vi.importActual<typeof import("./operator-auth-guard")>("./operator-auth-guard");

  return {
    ...actual,
    requireOperatorRequestSession: vi.fn()
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("workspace repository routes", () => {
  it("returns the GitHub installation repository inventory", async () => {
    const { requireReadyGitHubSetup } = await import("./github-setup-guard");
    const { requireOperatorRequestSession } = await import("./operator-auth-guard");
    const { listGitHubInstallationRepositories } = await import(
      "./github-installation-repositories"
    );
    const { GET } = await import("../app/api/github/repositories/route");

    vi.mocked(requireOperatorRequestSession).mockReturnValue({
      githubLogin: "operator",
      githubUserId: "1",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(requireReadyGitHubSetup).mockResolvedValue({
      state: "ready"
    } as never);
    vi.mocked(listGitHubInstallationRepositories).mockResolvedValue([
      {
        id: "repo-1",
        owner: "acme",
        name: "platform",
        fullName: "acme/platform",
        cloneUrl: "https://github.com/acme/platform.git"
      }
    ]);

    const response = await GET(new Request("https://github-symphony.local/api/github/repositories"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repositories: [
        {
          id: "repo-1",
          owner: "acme",
          name: "platform",
          fullName: "acme/platform",
          cloneUrl: "https://github.com/acme/platform.git"
        }
      ]
    });
  });

  it("surfaces degraded repository discovery errors", async () => {
    const { requireReadyGitHubSetup } = await import("./github-setup-guard");
    const { requireOperatorRequestSession } = await import("./operator-auth-guard");
    const { listGitHubInstallationRepositories } = await import(
      "./github-installation-repositories"
    );
    const { GET } = await import("../app/api/github/repositories/route");

    vi.mocked(requireOperatorRequestSession).mockReturnValue({
      githubLogin: "operator",
      githubUserId: "1",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(requireReadyGitHubSetup).mockResolvedValue({
      state: "ready"
    } as never);
    vi.mocked(listGitHubInstallationRepositories).mockRejectedValue(
      new Error("The configured machine-user PAT needs recovery before repositories can be listed.")
    );

    const response = await GET(new Request("https://github-symphony.local/api/github/repositories"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "The configured machine-user PAT needs recovery before repositories can be listed."
    });
  });

  it("validates repository selections against the live inventory before provisioning", async () => {
    const { requireReadyGitHubSetup } = await import("./github-setup-guard");
    const { requireOperatorRequestSession } = await import("./operator-auth-guard");
    const { resolveGitHubInstallationRepositorySelection } = await import(
      "./github-installation-repositories"
    );
    const { provisionWorkspace } = await import("./workspace-orchestrator");
    const { POST } = await import("../app/api/workspaces/route");

    vi.mocked(requireOperatorRequestSession).mockReturnValue({
      githubLogin: "operator",
      githubUserId: "1",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(requireReadyGitHubSetup).mockResolvedValue({
      state: "ready"
    } as never);
    vi.mocked(resolveGitHubInstallationRepositorySelection).mockResolvedValue([
      {
        id: "repo-1",
        owner: "acme",
        name: "platform",
        fullName: "acme/platform",
        cloneUrl: "https://github.com/acme/platform.git"
      }
    ]);
    vi.mocked(provisionWorkspace).mockResolvedValue({
      workspace: {
        id: "workspace-1",
        name: "Platform Workspace",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      },
      project: {
        id: "project-1",
        number: 7,
        title: "Platform Workspace",
        url: "https://github.com/orgs/acme/projects/7"
      },
      runtime: {
        runtimeDriver: "docker",
        runtimeId: "container-1",
        runtimeName: "symphony-platform-workspace",
        endpointHost: "127.0.0.1",
        port: 4501,
        workflowPath: "/tmp/workflow.md",
        workspaceRuntimeDir: "/tmp/runtime",
        processId: null
      }
    } as never);

    const response = await POST(
      new Request("https://github-symphony.local/api/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "Platform Workspace",
          promptGuidelines: "Prefer small changes",
          repositoryIds: ["repo-1"],
          agentCredentialSource: "platform_default"
        })
      })
    );

    expect(response.status).toBe(201);
    expect(resolveGitHubInstallationRepositorySelection).toHaveBeenCalledWith(["repo-1"]);
    expect(provisionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      })
    );
  });

  it("rejects stale repository selections before provisioning", async () => {
    const { requireReadyGitHubSetup } = await import("./github-setup-guard");
    const { requireOperatorRequestSession } = await import("./operator-auth-guard");
    const { resolveGitHubInstallationRepositorySelection } = await import(
      "./github-installation-repositories"
    );
    const { provisionWorkspace } = await import("./workspace-orchestrator");
    const { POST } = await import("../app/api/workspaces/route");

    vi.mocked(requireOperatorRequestSession).mockReturnValue({
      githubLogin: "operator",
      githubUserId: "1",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(requireReadyGitHubSetup).mockResolvedValue({
      state: "ready"
    } as never);
    vi.mocked(resolveGitHubInstallationRepositorySelection).mockRejectedValue(
      new Error(
        "One or more selected repositories are no longer available to the configured system GitHub provider. Refresh the repository list and try again."
      )
    );

    const response = await POST(
      new Request("https://github-symphony.local/api/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "Platform Workspace",
          promptGuidelines: "Prefer small changes",
          repositoryIds: ["repo-1"],
          agentCredentialSource: "platform_default"
        })
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "One or more selected repositories are no longer available to the configured system GitHub provider. Refresh the repository list and try again."
    });
    expect(provisionWorkspace).not.toHaveBeenCalled();
  });
});

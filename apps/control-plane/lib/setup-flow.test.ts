import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./github-app-api", async () => {
  const actual =
    await vi.importActual<typeof import("./github-app-api")>("./github-app-api");

  return {
    ...actual,
    convertGitHubAppManifest: vi.fn(),
    fetchGitHubInstallation: vi.fn()
  };
});

vi.mock("./github-integration", async () => {
  const actual =
    await vi.importActual<typeof import("./github-integration")>("./github-integration");

  return {
    ...actual,
    findGitHubBootstrapAttemptByStateToken: vi.fn(),
    loadConfiguredGitHubAppCredentials: vi.fn(),
    saveGitHubIntegration: vi.fn(),
    updateGitHubBootstrapAttempt: vi.fn(),
    resetGitHubBootstrapState: vi.fn()
  };
});

vi.mock("./github-integration-secrets", () => ({
  loadGitHubSecretProtectorFromEnv: vi.fn().mockReturnValue({
    encrypt: vi.fn((value: string) => `enc:${value}`)
  })
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("setup flow routes", () => {
  it("redirects to GitHub installation after a successful manifest callback", async () => {
    const { convertGitHubAppManifest } = await import("./github-app-api");
    const {
      findGitHubBootstrapAttemptByStateToken,
      saveGitHubIntegration,
      updateGitHubBootstrapAttempt
    } = await import("./github-integration");
    const { GET } = await import("../app/api/setup/github-app/callback/route");

    vi.mocked(findGitHubBootstrapAttemptByStateToken).mockResolvedValue({
      id: "attempt-1",
      expiresAt: new Date("2026-03-08T11:00:00.000Z")
    } as never);
    vi.mocked(convertGitHubAppManifest).mockResolvedValue({
      appId: "123",
      clientId: "Iv1.123",
      clientSecret: "client-secret",
      slug: "github-symphony",
      name: "GitHub Symphony",
      htmlUrl: "https://github.com/apps/github-symphony",
      privateKey: "private-key",
      webhookSecret: null
    });
    vi.mocked(saveGitHubIntegration).mockResolvedValue({
      id: "integration-1"
    } as never);

    const response = await GET(
      new Request(
        "https://github-symphony.local/api/setup/github-app/callback?code=manifest-code&state=state-token"
      )
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://github.com/apps/github-symphony/installations/new?state=state-token"
    );
    expect(updateGitHubBootstrapAttempt).toHaveBeenCalledWith(
      "attempt-1",
      expect.objectContaining({
        status: "converted"
      })
    );
  });

  it("marks setup ready after installation verification succeeds", async () => {
    const { fetchGitHubInstallation } = await import("./github-app-api");
    const {
      findGitHubBootstrapAttemptByStateToken,
      loadConfiguredGitHubAppCredentials,
      saveGitHubIntegration,
      updateGitHubBootstrapAttempt
    } = await import("./github-integration");
    const { GET } = await import(
      "../app/api/setup/github-app/install/callback/route"
    );

    vi.mocked(findGitHubBootstrapAttemptByStateToken).mockResolvedValue({
      id: "attempt-1"
    } as never);
    vi.mocked(loadConfiguredGitHubAppCredentials).mockResolvedValue({
      id: "integration-1",
      state: "pending",
      appId: "123",
      clientId: "Iv1.123",
      clientSecret: "client-secret",
      privateKey: "private-key",
      webhookSecret: null,
      appSlug: "github-symphony",
      appName: "GitHub Symphony",
      installationId: null,
      installationTargetLogin: null,
      installationTargetType: null,
      installationTargetUrl: null,
      lastValidatedAt: null
    });
    vi.mocked(fetchGitHubInstallation).mockResolvedValue({
      installationId: "installation-1",
      targetId: "1",
      targetLogin: "acme",
      targetType: "Organization",
      targetUrl: "https://github.com/acme"
    });

    const response = await GET(
      new Request(
        "https://github-symphony.local/api/setup/github-app/install/callback?installation_id=installation-1&state=state-token"
      )
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/setup/github-app?status=");
    expect(saveGitHubIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ready",
        installationTargetLogin: "acme"
      })
    );
    expect(updateGitHubBootstrapAttempt).toHaveBeenCalledWith(
      "attempt-1",
      expect.objectContaining({
        status: "completed"
      })
    );
  });

  it("resets stale setup state through the retry route", async () => {
    const { resetGitHubBootstrapState } = await import("./github-integration");
    const { POST } = await import("../app/api/setup/github-app/retry/route");

    const response = await POST(
      new Request("https://github-symphony.local/api/setup/github-app/retry", {
        method: "POST"
      })
    );

    expect(resetGitHubBootstrapState).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/setup/github-app?status=");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppBootstrapError } from "./github-app-api";
import {
  clearGitHubInstallationTokenCache,
  getBrokeredGitHubCredentials
} from "./github-installation-broker";

vi.mock("./github-app-api", async () => {
  const actual =
    await vi.importActual<typeof import("./github-app-api")>("./github-app-api");

  return {
    ...actual,
    fetchGitHubInstallation: vi.fn(),
    createGitHubInstallationAccessToken: vi.fn()
  };
});

vi.mock("./github-integration", async () => {
  const actual =
    await vi.importActual<typeof import("./github-integration")>("./github-integration");

  return {
    ...actual,
    loadReadyGitHubIntegration: vi.fn(),
    markGitHubIntegrationDegraded: vi.fn(),
    saveGitHubIntegration: vi.fn()
  };
});

afterEach(() => {
  clearGitHubInstallationTokenCache();
  vi.clearAllMocks();
});

describe("getBrokeredGitHubCredentials", () => {
  it("caches installation tokens until they approach expiry", async () => {
    const { createGitHubInstallationAccessToken, fetchGitHubInstallation } =
      await import("./github-app-api");
    const { loadReadyGitHubIntegration, saveGitHubIntegration } = await import(
      "./github-integration"
    );

    vi.mocked(loadReadyGitHubIntegration).mockResolvedValue({
      id: "integration-1",
      appId: "123",
      clientId: "Iv1.123",
      clientSecret: "client-secret",
      privateKey: "private-key",
      webhookSecret: null,
      appSlug: "github-symphony",
      appName: "GitHub Symphony",
      installationId: "installation-1",
      installationTargetLogin: "acme",
      installationTargetType: "Organization",
      installationTargetUrl: "https://github.com/acme",
      lastValidatedAt: null
    });
    vi.mocked(fetchGitHubInstallation).mockResolvedValue({
      installationId: "installation-1",
      targetId: "1",
      targetLogin: "acme",
      targetType: "Organization",
      targetUrl: "https://github.com/acme"
    });
    vi.mocked(createGitHubInstallationAccessToken).mockResolvedValue({
      token: "ghs_brokered",
      expiresAt: "2099-03-07T11:00:00.000Z"
    });

    const first = await getBrokeredGitHubCredentials();
    const second = await getBrokeredGitHubCredentials();

    expect(first.token).toBe("ghs_brokered");
    expect(second.token).toBe("ghs_brokered");
    expect(createGitHubInstallationAccessToken).toHaveBeenCalledTimes(1);
    expect(saveGitHubIntegration).toHaveBeenCalledTimes(1);
  });

  it("marks the integration degraded when GitHub reports a revoked installation", async () => {
    const { fetchGitHubInstallation } = await import("./github-app-api");
    const { loadReadyGitHubIntegration, markGitHubIntegrationDegraded } =
      await import("./github-integration");

    vi.mocked(loadReadyGitHubIntegration).mockResolvedValue({
      id: "integration-1",
      appId: "123",
      clientId: "Iv1.123",
      clientSecret: "client-secret",
      privateKey: "private-key",
      webhookSecret: null,
      appSlug: "github-symphony",
      appName: "GitHub Symphony",
      installationId: "installation-1",
      installationTargetLogin: "acme",
      installationTargetType: "Organization",
      installationTargetUrl: "https://github.com/acme",
      lastValidatedAt: null
    });
    vi.mocked(fetchGitHubInstallation).mockRejectedValue(
      new GitHubAppBootstrapError("Installation missing.", 404)
    );

    await expect(getBrokeredGitHubCredentials()).rejects.toThrow("Installation missing.");
    expect(markGitHubIntegrationDegraded).toHaveBeenCalledWith(
      "GitHub App installation is no longer valid. Reconnect the installation from setup.",
      undefined
    );
  });
});

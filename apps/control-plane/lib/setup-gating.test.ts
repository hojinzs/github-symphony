import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  })
}));

vi.mock("./github-integration", async () => {
  const actual =
    await vi.importActual<typeof import("./github-integration")>("./github-integration");

  return {
    ...actual,
    loadGitHubIntegrationSummary: vi.fn()
  };
});

describe("setup gating", () => {
  it("redirects workspace creation to setup on first boot", async () => {
    const { loadGitHubIntegrationSummary } = await import("./github-integration");
    const WorkspacePage = (await import("../app/workspaces/new/page")).default;

    vi.mocked(loadGitHubIntegrationSummary).mockResolvedValue({
      state: "unconfigured",
      missingFields: [],
      integration: null,
      latestBootstrapAttempt: null
    });

    await expect(WorkspacePage()).rejects.toThrow(
      "REDIRECT:/setup/github-app?next=%2Fworkspaces%2Fnew"
    );
  });

  it("redirects issue creation to setup when the integration is degraded", async () => {
    const { loadGitHubIntegrationSummary } = await import("./github-integration");
    const IssuePage = (await import("../app/issues/new/page")).default;

    vi.mocked(loadGitHubIntegrationSummary).mockResolvedValue({
      state: "degraded",
      missingFields: [],
      integration: {
        id: "integration-1",
        singletonKey: "system",
        status: "degraded",
        appId: "123",
        clientId: "Iv1.123",
        appSlug: "github-symphony",
        appName: "GitHub Symphony",
        installationId: "installation-1",
        installationTargetLogin: "acme",
        installationTargetType: "Organization",
        installationTargetUrl: "https://github.com/acme",
        degradedReason: "Installation revoked.",
        lastValidatedAt: null,
        createdAt: new Date("2026-03-07T10:00:00.000Z"),
        updatedAt: new Date("2026-03-07T10:00:00.000Z"),
        hasClientSecret: true,
        hasPrivateKey: true,
        hasWebhookSecret: false
      },
      latestBootstrapAttempt: null
    });

    await expect(IssuePage()).rejects.toThrow(
      "REDIRECT:/setup/github-app?next=%2Fissues%2Fnew"
    );
  });
});

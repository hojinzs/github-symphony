import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  })
}));

vi.mock("./operator-auth-guard", () => ({
  requireOperatorPageSession: vi.fn()
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
    const { requireOperatorPageSession } = await import("./operator-auth-guard");
    const WorkspacePage = (await import("../app/workspaces/new/page")).default;

    vi.mocked(requireOperatorPageSession).mockResolvedValue({
      githubLogin: "operator",
      githubUserId: "1",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(loadGitHubIntegrationSummary).mockResolvedValue({
      state: "unconfigured",
      missingFields: [],
      integration: null
    });

    await expect(WorkspacePage()).rejects.toThrow(
      "REDIRECT:/setup/github?next=%2Fworkspaces%2Fnew"
    );
  });

  it("redirects issue creation to setup when the integration is degraded", async () => {
    const { loadGitHubIntegrationSummary } = await import("./github-integration");
    const { requireOperatorPageSession } = await import("./operator-auth-guard");
    const IssuePage = (await import("../app/issues/new/page")).default;

    vi.mocked(requireOperatorPageSession).mockResolvedValue({
      githubLogin: "operator",
      githubUserId: "1",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(loadGitHubIntegrationSummary).mockResolvedValue({
      state: "degraded",
      missingFields: [],
      integration: {
        id: "integration-1",
        singletonKey: "system",
        status: "degraded",
        patTokenFingerprint: "pat-fingerprint",
        patActorId: "100",
        patActorLogin: "machine-user",
        patValidatedOwnerId: "200",
        patValidatedOwnerLogin: "acme",
        patValidatedOwnerType: "Organization",
        patValidatedOwnerUrl: "https://github.com/acme",
        degradedReason: "Installation revoked.",
        lastValidatedAt: null,
        createdAt: new Date("2026-03-07T10:00:00.000Z"),
        updatedAt: new Date("2026-03-07T10:00:00.000Z"),
        hasPatToken: true
      }
    });

    await expect(IssuePage()).rejects.toThrow(
      "REDIRECT:/setup/github?next=%2Fissues%2Fnew"
    );
  });
});

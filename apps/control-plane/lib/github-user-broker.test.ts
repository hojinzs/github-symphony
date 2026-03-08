import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectGitHubCredentials } from "./github-user-broker";

vi.mock("./github-integration", async () => {
  const actual =
    await vi.importActual<typeof import("./github-integration")>("./github-integration");

  return {
    ...actual,
    loadConfiguredGitHubPatCredentials: vi.fn(),
    loadGitHubIntegrationSummary: vi.fn(),
    markGitHubIntegrationDegraded: vi.fn(),
    saveGitHubIntegration: vi.fn()
  };
});

vi.mock("./github-pat-api", async () => {
  const actual =
    await vi.importActual<typeof import("./github-pat-api")>("./github-pat-api");

  return {
    ...actual,
    validateGitHubPat: vi.fn()
  };
});

describe("getProjectGitHubCredentials", () => {
  beforeEach(() => {
    vi.stubEnv(
      "PLATFORM_SECRETS_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns validated PAT credentials", async () => {
    const {
      loadConfiguredGitHubPatCredentials,
      loadGitHubIntegrationSummary,
      saveGitHubIntegration
    } = await import("./github-integration");
    const { validateGitHubPat } = await import("./github-pat-api");

    vi.mocked(loadGitHubIntegrationSummary).mockResolvedValue({
      state: "ready",
      missingFields: [],
      integration: {
        id: "integration-1",
        singletonKey: "system",
        status: "ready",
        patTokenFingerprint: "pat-fingerprint",
        patActorId: "100",
        patActorLogin: "machine-user",
        patValidatedOwnerId: "200",
        patValidatedOwnerLogin: "acme",
        patValidatedOwnerType: "Organization",
        patValidatedOwnerUrl: "https://github.com/acme",
        degradedReason: null,
        lastValidatedAt: null,
        createdAt: new Date("2026-03-07T10:00:00.000Z"),
        updatedAt: new Date("2026-03-07T10:00:00.000Z"),
        hasPatToken: true
      }
    });
    vi.mocked(loadConfiguredGitHubPatCredentials).mockResolvedValue({
      id: "integration-1",
      state: "ready",
      token: "ghp_machine_user",
      tokenFingerprint: "pat-fingerprint",
      actorId: "100",
      actorLogin: "machine-user",
      validatedOwnerId: "200",
      validatedOwnerLogin: "acme",
      validatedOwnerType: "Organization",
      validatedOwnerUrl: "https://github.com/acme",
      lastValidatedAt: null
    });
    vi.mocked(validateGitHubPat).mockResolvedValue({
      tokenFingerprint: "pat-fingerprint",
      actorId: "100",
      actorLogin: "machine-user",
      validatedOwnerId: "200",
      validatedOwnerLogin: "acme",
      validatedOwnerType: "Organization",
      validatedOwnerUrl: "https://github.com/acme"
    });

    const credentials = await getProjectGitHubCredentials();

    expect(credentials).toMatchObject({
      token: "ghp_machine_user",
      ownerLogin: "acme",
      provider: "pat_classic",
      source: "pat",
      actorLogin: "machine-user",
      tokenFingerprint: "pat-fingerprint"
    });
    expect(saveGitHubIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ready",
        patActorLogin: "machine-user"
      }),
      expect.anything()
    );
  });

  it("marks the PAT integration degraded when validation fails", async () => {
    const {
      loadConfiguredGitHubPatCredentials,
      loadGitHubIntegrationSummary,
      markGitHubIntegrationDegraded
    } = await import("./github-integration");
    const { GitHubPatValidationError, validateGitHubPat } = await import("./github-pat-api");

    vi.mocked(loadGitHubIntegrationSummary).mockResolvedValue({
      state: "ready",
      missingFields: [],
      integration: {
        id: "integration-1",
        singletonKey: "system",
        status: "ready",
        patTokenFingerprint: "pat-fingerprint",
        patActorId: "100",
        patActorLogin: "machine-user",
        patValidatedOwnerId: "200",
        patValidatedOwnerLogin: "acme",
        patValidatedOwnerType: "Organization",
        patValidatedOwnerUrl: "https://github.com/acme",
        degradedReason: null,
        lastValidatedAt: null,
        createdAt: new Date("2026-03-07T10:00:00.000Z"),
        updatedAt: new Date("2026-03-07T10:00:00.000Z"),
        hasPatToken: true
      }
    });
    vi.mocked(loadConfiguredGitHubPatCredentials).mockResolvedValue({
      id: "integration-1",
      state: "ready",
      token: "ghp_machine_user",
      tokenFingerprint: "pat-fingerprint",
      actorId: "100",
      actorLogin: "machine-user",
      validatedOwnerId: "200",
      validatedOwnerLogin: "acme",
      validatedOwnerType: "Organization",
      validatedOwnerUrl: "https://github.com/acme",
      lastValidatedAt: null
    });
    vi.mocked(validateGitHubPat).mockRejectedValue(
      new GitHubPatValidationError("Authentication failed.", "authentication", 401)
    );

    await expect(getProjectGitHubCredentials()).rejects.toThrow("Authentication failed.");
    expect(markGitHubIntegrationDegraded).toHaveBeenCalledWith(
      expect.stringContaining("machine-user PAT is no longer valid"),
      expect.anything()
    );
  });
});

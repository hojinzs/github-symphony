import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  })
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(undefined)
  })
}));

vi.mock("./github-integration", async () => {
  const actual =
    await vi.importActual<typeof import("./github-integration")>("./github-integration");

  return {
    ...actual,
    loadGitHubIntegrationSummary: vi.fn().mockResolvedValue({
      state: "ready",
      missingFields: [],
      blockingIssues: [],
      integration: null,
      latestBootstrapAttempt: null
    })
  };
});

describe("operator page access", () => {
  it("redirects unauthenticated workspace access to sign-in with the intended return path", async () => {
    const WorkspacePage = (await import("../app/workspaces/new/page")).default;

    await expect(WorkspacePage()).rejects.toThrow(
      "REDIRECT:/sign-in?next=%2Fworkspaces%2Fnew"
    );
  });
});

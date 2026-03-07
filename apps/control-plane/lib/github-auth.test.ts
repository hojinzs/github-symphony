import { describe, expect, it, vi } from "vitest";
import {
  authenticateGitHubRequest,
  extractGitHubToken,
  fingerprintGitHubToken,
  GitHubAuthError
} from "./github-auth";

describe("extractGitHubToken", () => {
  it("reads explicit GitHub token headers", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-github-token": "ghp_secret"
      }
    });

    expect(extractGitHubToken(request)).toBe("ghp_secret");
  });

  it("falls back to bearer authorization", () => {
    const request = new Request("https://example.com", {
      headers: {
        authorization: "Bearer ghp_secret"
      }
    });

    expect(extractGitHubToken(request)).toBe("ghp_secret");
  });
});

describe("fingerprintGitHubToken", () => {
  it("generates a deterministic token fingerprint", () => {
    expect(fingerprintGitHubToken("ghp_secret")).toHaveLength(64);
  });
});

describe("authenticateGitHubRequest", () => {
  it("hydrates a GitHub auth session from the GitHub user API", async () => {
    const request = new Request("https://example.com", {
      headers: {
        authorization: "Bearer ghp_secret"
      }
    });

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 42, login: "acme-user" }), {
        status: 200,
        headers: {
          "x-oauth-scopes": "repo, read:project"
        }
      })
    );

    const session = await authenticateGitHubRequest(request, fetchImpl as typeof fetch);

    expect(session.githubLogin).toBe("acme-user");
    expect(session.githubUserId).toBe("42");
    expect(session.scopes).toEqual(["repo", "read:project"]);
  });

  it("fails when the request is unauthenticated", async () => {
    const request = new Request("https://example.com");

    await expect(authenticateGitHubRequest(request)).rejects.toBeInstanceOf(
      GitHubAuthError
    );
  });
});

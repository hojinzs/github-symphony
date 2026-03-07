import { createHash } from "node:crypto";

const GITHUB_USER_API_URL = "https://api.github.com/user";

export class GitHubAuthError extends Error {}

export type GitHubAuthSession = {
  authType: "pat";
  token: string;
  githubLogin: string;
  githubUserId: string;
  scopes: string[];
  tokenFingerprint: string;
};

export function fingerprintGitHubToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function authenticateGitHubRequest(
  request: Request,
  fetchImpl: typeof fetch = fetch
): Promise<GitHubAuthSession> {
  const token = extractGitHubToken(request);
  const user = await fetchGitHubUser(token, fetchImpl);

  return {
    authType: "pat",
    token,
    githubLogin: user.githubLogin,
    githubUserId: user.githubUserId,
    scopes: user.scopes,
    tokenFingerprint: fingerprintGitHubToken(token)
  };
}

export function extractGitHubToken(request: Request): string {
  const authHeader = request.headers.get("authorization");
  const explicitToken = request.headers.get("x-github-token");

  if (explicitToken) {
    return explicitToken.trim();
  }

  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  throw new GitHubAuthError("GitHub authentication is required.");
}

async function fetchGitHubUser(
  token: string,
  fetchImpl: typeof fetch
): Promise<Pick<GitHubAuthSession, "githubLogin" | "githubUserId" | "scopes">> {
  const response = await fetchImpl(GITHUB_USER_API_URL, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "github-symphony"
    }
  });

  if (!response.ok) {
    throw new GitHubAuthError(
      `GitHub authentication failed with status ${response.status}.`
    );
  }

  const payload = (await response.json()) as {
    id?: number;
    login?: string;
  };

  if (!payload.login || !payload.id) {
    throw new GitHubAuthError("GitHub user lookup returned an incomplete profile.");
  }

  return {
    githubLogin: payload.login,
    githubUserId: String(payload.id),
    scopes: response.headers
      .get("x-oauth-scopes")
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean) ?? []
  };
}

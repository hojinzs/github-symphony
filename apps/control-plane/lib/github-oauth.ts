const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

type GitHubFetch = typeof fetch;

export class GitHubOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export type GitHubUserAccessToken = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string;
  tokenType: string;
};

export function buildGitHubOAuthAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GITHUB_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeGitHubOAuthCode(
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
  fetchImpl: GitHubFetch = fetch
): Promise<GitHubUserAccessToken> {
  const response = await fetchImpl(GITHUB_OAUTH_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "github-symphony"
    },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri
    })
  });

  if (!response.ok) {
    throw new GitHubOAuthError(
      `GitHub user token exchange failed with status ${response.status}.`,
      response.status
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (payload.error) {
    throw new GitHubOAuthError(
      payload.error_description
        ? `${payload.error}: ${payload.error_description}`
        : payload.error
    );
  }

  if (!payload.access_token || !payload.token_type) {
    throw new GitHubOAuthError(
      "GitHub user token exchange returned an incomplete response."
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    accessTokenExpiresAt:
      typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
    refreshTokenExpiresAt:
      typeof payload.refresh_token_expires_in === "number"
        ? new Date(Date.now() + payload.refresh_token_expires_in * 1000)
        : null,
    scope: payload.scope ?? "",
    tokenType: payload.token_type
  };
}

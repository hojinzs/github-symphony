import { createSign } from "node:crypto";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_NEW_APP_URL = "https://github.com/settings/apps/new";
const GITHUB_APP_INSTALL_URL = "https://github.com/apps";

type GitHubFetch = typeof fetch;

export class GitHubAppBootstrapError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export type GitHubAppManifest = {
  name: string;
  description: string;
  url: string;
  redirect_url: string;
  setup_url: string;
  public: boolean;
  default_permissions: Record<string, "read" | "write">;
  default_events: string[];
};

export type GitHubAppManifestConversion = {
  appId: string;
  clientId: string;
  clientSecret: string;
  slug: string;
  name: string;
  htmlUrl: string | null;
  privateKey: string;
  webhookSecret: string | null;
};

export type GitHubInstallationDetails = {
  installationId: string;
  targetId: string | null;
  targetLogin: string;
  targetType: string;
  targetUrl: string | null;
};

export type GitHubInstallationAccessToken = {
  token: string;
  expiresAt: string;
};

export function buildGitHubAppManifest(baseUrl: string): GitHubAppManifest {
  return {
    name: "GitHub Symphony",
    description:
      "Trusted-operator GitHub App for Symphony workspace provisioning and issue execution.",
    url: baseUrl,
    redirect_url: `${baseUrl}/api/setup/github-app/callback`,
    setup_url: `${baseUrl}/api/setup/github-app/install/callback`,
    public: false,
    default_permissions: {
      metadata: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
      repository_projects: "write",
      organization_projects: "write"
    },
    default_events: []
  };
}

export function buildGitHubManifestStartHtml(input: {
  state: string;
  manifest: GitHubAppManifest;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GitHub Symphony Setup</title>
  </head>
  <body>
    <form id="github-app-manifest" action="${GITHUB_NEW_APP_URL}?state=${encodeURIComponent(
      input.state
    )}" method="post">
      <input type="hidden" name="manifest" value="${escapeHtml(
        JSON.stringify(input.manifest)
      )}" />
    </form>
    <script>
      document.getElementById("github-app-manifest")?.submit();
    </script>
  </body>
</html>`;
}

export function buildGitHubAppInstallUrl(appSlug: string, state?: string): string {
  const url = new URL(
    `${GITHUB_APP_INSTALL_URL}/${encodeURIComponent(appSlug)}/installations/new`
  );

  if (state) {
    url.searchParams.set("state", state);
  }

  return url.toString();
}

export function createGitHubAppJwt(input: {
  appId: string;
  privateKey: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = encodeJwtPart({
    alg: "RS256",
    typ: "JWT"
  });
  const payload = encodeJwtPart({
    iat: issuedAt,
    exp: expiresAt,
    iss: input.appId
  });
  const signer = createSign("RSA-SHA256");
  const signingInput = `${header}.${payload}`;

  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(input.privateKey).toString("base64url");

  return `${signingInput}.${signature}`;
}

export async function convertGitHubAppManifest(
  code: string,
  fetchImpl: GitHubFetch = fetch
): Promise<GitHubAppManifestConversion> {
  const response = await fetchImpl(
    `${GITHUB_API_URL}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "github-symphony"
      }
    }
  );

  if (!response.ok) {
    throw new GitHubAppBootstrapError(
      `GitHub manifest conversion failed with status ${response.status}.`,
      response.status
    );
  }

  const payload = (await response.json()) as {
    id?: number;
    client_id?: string;
    client_secret?: string;
    slug?: string;
    name?: string;
    html_url?: string;
    pem?: string;
    webhook_secret?: string;
  };

  if (
    !payload.id ||
    !payload.client_id ||
    !payload.client_secret ||
    !payload.slug ||
    !payload.name ||
    !payload.pem
  ) {
    throw new GitHubAppBootstrapError(
      "GitHub manifest conversion returned incomplete app credentials."
    );
  }

  return {
    appId: String(payload.id),
    clientId: payload.client_id,
    clientSecret: payload.client_secret,
    slug: payload.slug,
    name: payload.name,
    htmlUrl: payload.html_url ?? null,
    privateKey: payload.pem,
    webhookSecret: payload.webhook_secret ?? null
  };
}

export async function fetchGitHubInstallation(
  input: {
    appId: string;
    privateKey: string;
    installationId: string;
  },
  fetchImpl: GitHubFetch = fetch
): Promise<GitHubInstallationDetails> {
  const response = await fetchImpl(
    `${GITHUB_API_URL}/app/installations/${encodeURIComponent(input.installationId)}`,
    {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createGitHubAppJwt({
          appId: input.appId,
          privateKey: input.privateKey
        })}`,
        "user-agent": "github-symphony"
      }
    }
  );

  if (!response.ok) {
    throw new GitHubAppBootstrapError(
      `GitHub installation lookup failed with status ${response.status}.`,
      response.status
    );
  }

  const payload = (await response.json()) as {
    id?: number;
    target_id?: number;
    account?: {
      login?: string;
      type?: string;
      html_url?: string;
    };
  };

  if (!payload.id || !payload.account?.login || !payload.account.type) {
    throw new GitHubAppBootstrapError(
      "GitHub installation lookup returned incomplete installation data."
    );
  }

  return {
    installationId: String(payload.id),
    targetId: payload.target_id ? String(payload.target_id) : null,
    targetLogin: payload.account.login,
    targetType: payload.account.type,
    targetUrl: payload.account.html_url ?? null
  };
}

export async function createGitHubInstallationAccessToken(
  input: {
    appId: string;
    privateKey: string;
    installationId: string;
  },
  fetchImpl: GitHubFetch = fetch
): Promise<GitHubInstallationAccessToken> {
  const response = await fetchImpl(
    `${GITHUB_API_URL}/app/installations/${encodeURIComponent(
      input.installationId
    )}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createGitHubAppJwt({
          appId: input.appId,
          privateKey: input.privateKey
        })}`,
        "content-type": "application/json",
        "user-agent": "github-symphony"
      },
      body: JSON.stringify({})
    }
  );

  if (!response.ok) {
    throw new GitHubAppBootstrapError(
      `GitHub installation token request failed with status ${response.status}.`,
      response.status
    );
  }

  const payload = (await response.json()) as {
    token?: string;
    expires_at?: string;
  };

  if (!payload.token || !payload.expires_at) {
    throw new GitHubAppBootstrapError(
      "GitHub installation token response was incomplete."
    );
  }

  return {
    token: payload.token,
    expiresAt: payload.expires_at
  };
}

function encodeJwtPart(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

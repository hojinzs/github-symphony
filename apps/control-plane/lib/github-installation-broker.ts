import { GitHubIntegrationStatus } from "@prisma/client";
import {
  createGitHubInstallationAccessToken,
  fetchGitHubInstallation,
  GitHubAppBootstrapError
} from "./github-app-api";
import { db } from "./db";
import {
  loadReadyGitHubIntegration,
  markGitHubIntegrationDegraded,
  saveGitHubIntegration
} from "./github-integration";

const TOKEN_REUSE_WINDOW_MS = 5 * 60 * 1000;

type DatabaseLike = Pick<typeof db, "gitHubIntegration" | "gitHubBootstrapAttempt">;

type CachedInstallationToken = {
  token: string;
  expiresAt: Date;
};

const installationTokenCache = new Map<string, CachedInstallationToken>();

export type BrokeredGitHubCredentials = {
  token: string;
  expiresAt: Date;
  installationId: string;
  ownerLogin: string;
  ownerType: string;
};

export async function getBrokeredGitHubCredentials(
  dependencies: {
    db?: DatabaseLike;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<BrokeredGitHubCredentials> {
  const database = dependencies.db;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const integration = await loadReadyGitHubIntegration(database);
  const cached = installationTokenCache.get(integration.installationId);

  if (
    cached &&
    cached.expiresAt.getTime() - Date.now() > TOKEN_REUSE_WINDOW_MS
  ) {
    return {
      token: cached.token,
      expiresAt: cached.expiresAt,
      installationId: integration.installationId,
      ownerLogin: integration.installationTargetLogin,
      ownerType: integration.installationTargetType
    };
  }

  try {
    const installation = await fetchGitHubInstallation(
      {
        appId: integration.appId,
        privateKey: integration.privateKey,
        installationId: integration.installationId
      },
      fetchImpl
    );
    const token = await createGitHubInstallationAccessToken(
      {
        appId: integration.appId,
        privateKey: integration.privateKey,
        installationId: integration.installationId
      },
      fetchImpl
    );
    const expiresAt = new Date(token.expiresAt);

    installationTokenCache.set(integration.installationId, {
      token: token.token,
      expiresAt
    });
    await saveGitHubIntegration(
      {
        status: GitHubIntegrationStatus.ready,
        installationId: installation.installationId,
        installationTargetId: installation.targetId,
        installationTargetLogin: installation.targetLogin,
        installationTargetType: installation.targetType,
        installationTargetUrl: installation.targetUrl,
        lastValidatedAt: new Date(),
        degradedReason: null
      },
      database
    );

    return {
      token: token.token,
      expiresAt,
      installationId: installation.installationId,
      ownerLogin: installation.targetLogin,
      ownerType: installation.targetType
    };
  } catch (error) {
    if (
      error instanceof GitHubAppBootstrapError &&
      shouldMarkIntegrationDegraded(error.status)
    ) {
      installationTokenCache.delete(integration.installationId);
      await markGitHubIntegrationDegraded(
        "GitHub App installation is no longer valid. Reconnect the installation from setup.",
        database
      );
    }

    throw error;
  }
}

export function clearGitHubInstallationTokenCache(installationId?: string): void {
  if (installationId) {
    installationTokenCache.delete(installationId);
    return;
  }

  installationTokenCache.clear();
}

function shouldMarkIntegrationDegraded(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

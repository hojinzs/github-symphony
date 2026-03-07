import { db } from "./db";
import { getBrokeredGitHubCredentials } from "./github-installation-broker";
import {
  buildWorkspaceRuntimeBrokerUrl,
  deriveWorkspaceRuntimeAuthSecret,
  extractRuntimeAuthorizationSecret as extractWorkspaceRuntimeAuthorizationSecret,
  verifyWorkspaceRuntimeAuthSecret,
  WorkspaceRuntimeAuthError
} from "./runtime-broker-auth";

export {
  deriveWorkspaceRuntimeAuthSecret,
  verifyWorkspaceRuntimeAuthSecret,
  WorkspaceRuntimeAuthError
};

export function buildWorkspaceRuntimeTokenBrokerUrl(
  workspaceId: string,
  env: Record<string, string | undefined> = process.env
): string {
  return buildWorkspaceRuntimeBrokerUrl(workspaceId, "runtime-credentials", env);
}

export async function issueWorkspaceRuntimeCredentials(
  workspaceId: string,
  dependencies: {
    db?: Pick<typeof db, "workspace">;
    fetchImpl?: typeof fetch;
    credentialBroker?: typeof getBrokeredGitHubCredentials;
  } = {}
) {
  const database = dependencies.db ?? db;
  const workspace = await database.workspace.findUnique({
    where: {
      id: workspaceId
    },
    select: {
      id: true,
      githubProjectId: true
    }
  });

  if (!workspace || !workspace.githubProjectId) {
    throw new WorkspaceRuntimeAuthError(
      "Workspace runtime credentials are unavailable for this workspace."
    );
  }

  const credentialBroker =
    dependencies.credentialBroker ?? getBrokeredGitHubCredentials;
  const credentials = await credentialBroker({
    fetchImpl: dependencies.fetchImpl
  });

  return {
    token: credentials.token,
    expiresAt: credentials.expiresAt.toISOString(),
    githubProjectId: workspace.githubProjectId,
    gitHostname: "github.com",
    gitUsername: "x-access-token",
    supports: {
      githubGraphql: true,
      gitPush: true,
      pullRequests: true
    }
  };
}

export function extractRuntimeAuthorizationSecret(request: Request): string {
  return extractWorkspaceRuntimeAuthorizationSecret(request);
}

import { db } from "./db";
import { getProjectGitHubCredentials } from "./github-user-broker";
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
    credentialBroker?: typeof getProjectGitHubCredentials;
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
    dependencies.credentialBroker ?? getProjectGitHubCredentials;
  const credentials = await credentialBroker({
    db: database as never,
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

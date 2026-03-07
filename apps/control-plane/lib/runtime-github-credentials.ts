import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { getBrokeredGitHubCredentials } from "./github-installation-broker";

const CONTROL_PLANE_RUNTIME_URL_ENV = "CONTROL_PLANE_RUNTIME_URL";
const WORKSPACE_RUNTIME_AUTH_SECRET_ENV = "WORKSPACE_RUNTIME_AUTH_SECRET";

export class WorkspaceRuntimeAuthError extends Error {}

export function buildWorkspaceRuntimeTokenBrokerUrl(
  workspaceId: string,
  env: Record<string, string | undefined> = process.env
): string {
  const baseUrl =
    env[CONTROL_PLANE_RUNTIME_URL_ENV] ??
    env.CONTROL_PLANE_BASE_URL ??
    "http://host.docker.internal:3000";

  return `${baseUrl.replace(/\/+$/, "")}/api/workspaces/${encodeURIComponent(
    workspaceId
  )}/runtime-credentials`;
}

export function deriveWorkspaceRuntimeAuthSecret(
  workspaceId: string,
  env: Record<string, string | undefined> = process.env
): string {
  const secretSeed =
    env[WORKSPACE_RUNTIME_AUTH_SECRET_ENV] ?? env.GITHUB_APP_SECRETS_KEY;

  if (!secretSeed) {
    throw new WorkspaceRuntimeAuthError(
      `${WORKSPACE_RUNTIME_AUTH_SECRET_ENV} or GITHUB_APP_SECRETS_KEY is required for runtime credential refresh.`
    );
  }

  return createHmac("sha256", secretSeed).update(workspaceId).digest("hex");
}

export function verifyWorkspaceRuntimeAuthSecret(
  workspaceId: string,
  candidateSecret: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  const expectedSecret = deriveWorkspaceRuntimeAuthSecret(workspaceId, env);
  const expectedBuffer = Buffer.from(expectedSecret);
  const candidateBuffer = Buffer.from(candidateSecret.trim());

  if (expectedBuffer.byteLength !== candidateBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, candidateBuffer);
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
  const explicitSecret = request.headers.get("x-symphony-runtime-auth");

  if (explicitSecret) {
    return explicitSecret.trim();
  }

  const authorization = request.headers.get("authorization");

  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  throw new WorkspaceRuntimeAuthError("Workspace runtime authentication is required.");
}

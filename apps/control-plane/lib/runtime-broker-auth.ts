import { createHmac, timingSafeEqual } from "node:crypto";

const CONTROL_PLANE_RUNTIME_URL_ENV = "CONTROL_PLANE_RUNTIME_URL";
const WORKSPACE_RUNTIME_AUTH_SECRET_ENV = "WORKSPACE_RUNTIME_AUTH_SECRET";

export class WorkspaceRuntimeAuthError extends Error {}

export function buildWorkspaceRuntimeBrokerUrl(
  workspaceId: string,
  brokerPath: string,
  env: Record<string, string | undefined> = process.env
): string {
  const baseUrl =
    env[CONTROL_PLANE_RUNTIME_URL_ENV] ??
    env.CONTROL_PLANE_BASE_URL ??
    "http://host.docker.internal:3000";

  return `${baseUrl.replace(/\/+$/, "")}/api/workspaces/${encodeURIComponent(
    workspaceId
  )}/${brokerPath.replace(/^\/+/, "")}`;
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

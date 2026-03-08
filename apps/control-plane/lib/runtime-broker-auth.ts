import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveControlPlaneRuntimeUrl } from "./runtime-config";

const WORKSPACE_RUNTIME_AUTH_SECRET_ENV = "WORKSPACE_RUNTIME_AUTH_SECRET";

export class WorkspaceRuntimeAuthError extends Error {}

export function buildWorkspaceRuntimeBrokerUrl(
  workspaceId: string,
  brokerPath: string,
  env: Record<string, string | undefined> = process.env
): string {
  const baseUrl = resolveControlPlaneRuntimeUrl(env);

  return `${baseUrl.replace(/\/+$/, "")}/api/workspaces/${encodeURIComponent(
    workspaceId
  )}/${brokerPath.replace(/^\/+/, "")}`;
}

export function deriveWorkspaceRuntimeAuthSecret(
  workspaceId: string,
  env: Record<string, string | undefined> = process.env
): string {
  const secretSeed = env[WORKSPACE_RUNTIME_AUTH_SECRET_ENV];

  if (!secretSeed) {
    throw new WorkspaceRuntimeAuthError(
      `${WORKSPACE_RUNTIME_AUTH_SECRET_ENV} is required for runtime credential refresh.`
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

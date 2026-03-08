import { NextResponse } from "next/server";
import { db } from "../../../../../lib/db";
import { GitHubIntegrationStateError } from "../../../../../lib/github-integration";
import { GitHubPatValidationError } from "../../../../../lib/github-pat-api";
import {
  extractRuntimeAuthorizationSecret,
  issueWorkspaceRuntimeCredentials,
  verifyWorkspaceRuntimeAuthSecret,
  WorkspaceRuntimeAuthError
} from "../../../../../lib/runtime-github-credentials";

type RuntimeCredentialRouteProps = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function POST(
  request: Request,
  { params }: RuntimeCredentialRouteProps
) {
  const { workspaceId } = await params;

  try {
    const secret = extractRuntimeAuthorizationSecret(request);

    if (!verifyWorkspaceRuntimeAuthSecret(workspaceId, secret)) {
      throw new WorkspaceRuntimeAuthError("Workspace runtime authentication failed.");
    }

    const credentials = await issueWorkspaceRuntimeCredentials(workspaceId);

    return NextResponse.json(credentials);
  } catch (error) {
    if (
      error instanceof GitHubPatValidationError ||
      error instanceof GitHubIntegrationStateError
    ) {
      await db.symphonyInstance
        .update({
          where: {
            workspaceId
          },
          data: {
            status: "degraded"
          }
        })
        .catch(() => undefined);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof WorkspaceRuntimeAuthError
        ? 401
        : error instanceof GitHubIntegrationStateError
          ? 503
          : error instanceof GitHubPatValidationError
            ? 502
            : 400;

    return NextResponse.json(
      {
        error: message
      },
      {
        status
      }
    );
  }
}

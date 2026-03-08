import { GitHubIntegrationStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { saveGitHubIntegration } from "../../../../lib/github-integration";
import { loadGitHubSecretProtectorFromEnv } from "../../../../lib/github-integration-secrets";
import {
  GitHubPatValidationError,
  validateGitHubPat
} from "../../../../lib/github-pat-api";
import {
  createOperatorAuthRedirectResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../../lib/operator-auth-guard";

export async function POST(request: Request) {
  try {
    requireOperatorRequestSession(request);

    const formData = await request.formData();
    const token = readRequiredField(formData, "token");
    const ownerLogin = readRequiredField(formData, "ownerLogin");
    const validated = await validateGitHubPat({
      token,
      ownerLogin
    });
    const secretProtector = loadGitHubSecretProtectorFromEnv();

    await saveGitHubIntegration({
      status: GitHubIntegrationStatus.ready,
      encryptedPatToken: secretProtector.encrypt(token),
      patTokenFingerprint: validated.tokenFingerprint,
      patActorId: validated.actorId,
      patActorLogin: validated.actorLogin,
      patValidatedOwnerId: validated.validatedOwnerId,
      patValidatedOwnerLogin: validated.validatedOwnerLogin,
      patValidatedOwnerType: validated.validatedOwnerType,
      patValidatedOwnerUrl: validated.validatedOwnerUrl,
      lastValidatedAt: new Date(),
      degradedReason: null
    });

    return redirectToSetup(
      request,
      null,
      "Machine-user PAT setup is complete. Workspace and issue creation are unlocked."
    );
  } catch (error) {
    if (error instanceof OperatorAuthRequiredError) {
      return createOperatorAuthRedirectResponse(request, "/setup/github");
    }

    const message =
      error instanceof Error
        ? error.message
        : "Machine-user PAT setup could not be completed.";

    await saveGitHubIntegration({
      status: GitHubIntegrationStatus.degraded,
      degradedReason: message
    });

    return redirectToSetup(request, message);
  }
}

function readRequiredField(formData: FormData, field: string): string {
  const value = formData.get(field);

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be provided.`);
  }

  return value.trim();
}

function redirectToSetup(
  request: Request,
  error: string | null,
  status?: string
) {
  const url = new URL("/setup/github", request.url);

  if (error) {
    url.searchParams.set("error", error);
  }

  if (status) {
    url.searchParams.set("status", status);
  }

  return NextResponse.redirect(url, 303);
}

import { GitHubBootstrapAttemptStatus, GitHubIntegrationStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import {
  fetchGitHubInstallation,
  GitHubAppBootstrapError
} from "../../../../../../lib/github-app-api";
import {
  findGitHubBootstrapAttemptByStateToken,
  loadConfiguredGitHubAppCredentials,
  saveGitHubIntegration,
  updateGitHubBootstrapAttempt
} from "../../../../../../lib/github-integration";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");

  if (!installationId || !state) {
    return redirectToSetup(
      request,
      "GitHub installation did not return the information required to finish setup."
    );
  }

  const attempt = await findGitHubBootstrapAttemptByStateToken(state);

  if (!attempt) {
    return redirectToSetup(request, "This GitHub installation session has expired.");
  }

  try {
    const integration = await loadConfiguredGitHubAppCredentials();
    const installation = await fetchGitHubInstallation({
      appId: integration.appId,
      privateKey: integration.privateKey,
      installationId
    });

    await saveGitHubIntegration({
      status: GitHubIntegrationStatus.ready,
      installationId: installation.installationId,
      installationTargetId: installation.targetId,
      installationTargetLogin: installation.targetLogin,
      installationTargetType: installation.targetType,
      installationTargetUrl: installation.targetUrl,
      lastValidatedAt: new Date(),
      degradedReason: null
    });
    await updateGitHubBootstrapAttempt(attempt.id, {
      status: GitHubBootstrapAttemptStatus.completed,
      installationId: installation.installationId,
      completedAt: new Date(),
      failureReason: null
    });

    return redirectToSetup(request, null, "GitHub App setup is complete.");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub App installation could not be verified.";

    await updateGitHubBootstrapAttempt(attempt.id, {
      status: GitHubBootstrapAttemptStatus.failed,
      failureReason: message
    });
    await saveGitHubIntegration({
      status: GitHubIntegrationStatus.degraded,
      degradedReason: message
    });

    return redirectToSetup(
      request,
      error instanceof GitHubAppBootstrapError ? message : "GitHub App installation could not be verified."
    );
  }
}

function redirectToSetup(
  request: Request,
  error: string | null,
  status?: string
) {
  const url = new URL("/setup/github-app", request.url);

  if (error) {
    url.searchParams.set("error", error);
  }

  if (status) {
    url.searchParams.set("status", status);
  }

  return NextResponse.redirect(url, 303);
}

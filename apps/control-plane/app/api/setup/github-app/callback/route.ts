import { GitHubBootstrapAttemptStatus, GitHubIntegrationStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import {
  buildGitHubAppInstallUrl,
  convertGitHubAppManifest,
  GitHubAppBootstrapError
} from "../../../../../lib/github-app-api";
import {
  findGitHubBootstrapAttemptByStateToken,
  saveGitHubIntegration,
  updateGitHubBootstrapAttempt
} from "../../../../../lib/github-integration";
import { loadGitHubSecretProtectorFromEnv } from "../../../../../lib/github-integration-secrets";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return redirectToSetup(request, "GitHub did not return a valid manifest callback.");
  }

  const attempt = await findGitHubBootstrapAttemptByStateToken(state);

  if (!attempt) {
    return redirectToSetup(request, "This GitHub App setup session has expired.");
  }

  if (attempt.expiresAt.getTime() <= Date.now()) {
    await updateGitHubBootstrapAttempt(attempt.id, {
      status: GitHubBootstrapAttemptStatus.expired,
      failureReason: "GitHub App setup state expired before callback completed."
    });

    return redirectToSetup(request, "This GitHub App setup session expired. Start over.");
  }

  try {
    const conversion = await convertGitHubAppManifest(code);
    const secretProtector = loadGitHubSecretProtectorFromEnv();
    const integration = await saveGitHubIntegration({
      status: GitHubIntegrationStatus.pending,
      appId: conversion.appId,
      clientId: conversion.clientId,
      appSlug: conversion.slug,
      appName: conversion.name,
      appSetupUrl: conversion.htmlUrl,
      encryptedClientSecret: secretProtector.encrypt(conversion.clientSecret),
      encryptedPrivateKey: secretProtector.encrypt(conversion.privateKey),
      encryptedWebhookSecret: conversion.webhookSecret
        ? secretProtector.encrypt(conversion.webhookSecret)
        : null,
      manifestCreatedAt: new Date(),
      degradedReason: null
    });

    await updateGitHubBootstrapAttempt(attempt.id, {
      status: GitHubBootstrapAttemptStatus.converted,
      integrationId: integration.id,
      conversionCompletedAt: new Date(),
      failureReason: null
    });

    return NextResponse.redirect(
      buildGitHubAppInstallUrl(conversion.slug, state),
      303
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub App setup could not continue.";

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
      error instanceof GitHubAppBootstrapError ? message : "GitHub App conversion failed."
    );
  }
}

function redirectToSetup(request: Request, error: string) {
  const url = new URL("/setup/github-app", request.url);
  url.searchParams.set("error", error);

  return NextResponse.redirect(url, 303);
}
